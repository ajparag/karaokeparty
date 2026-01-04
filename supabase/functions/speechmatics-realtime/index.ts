import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Generate a short-lived JWT for Speechmatics real-time API
async function generateSpeechmaticsJWT(apiKey: string): Promise<string> {
  const response = await fetch('https://mp.speechmatics.com/v1/api_keys?type=rt', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: 3600 }), // 1 hour TTL
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[jwt] Failed to generate JWT:', response.status, text);
    throw new Error(`Failed to generate JWT: ${response.status}`);
  }

  const data = await response.json();
  console.log('[jwt] Generated short-lived JWT');
  return data.key_value;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const upgradeHeader = req.headers.get("upgrade") || "";

  // WebSocket upgrade request
  if (upgradeHeader.toLowerCase() === "websocket") {
    const SPEECHMATICS_API_KEY = Deno.env.get('SPEECHMATICS_API_KEY');
    if (!SPEECHMATICS_API_KEY) {
      console.error('SPEECHMATICS_API_KEY not configured');
      return new Response('API key not configured', { status: 500 });
    }

    const { socket: clientSocket, response } = Deno.upgradeWebSocket(req);

    let speechmaticsSocket: WebSocket | null = null;
    let isConnected = false;

    clientSocket.onopen = async () => {
      console.log('[relay] Client connected');

      try {
        // Generate a short-lived JWT for real-time API
        const jwt = await generateSpeechmaticsJWT(SPEECHMATICS_API_KEY);

        // Connect to Speechmatics real-time API with JWT
        const wsUrl = `wss://eu2.rt.speechmatics.com/v2?jwt=${jwt}`;
        speechmaticsSocket = new WebSocket(wsUrl);

        speechmaticsSocket.onopen = () => {
          console.log('[relay] Connected to Speechmatics');

          // Send StartRecognition message for Hindi
          const startMessage = {
            message: 'StartRecognition',
            audio_format: {
              type: 'raw',
              encoding: 'pcm_s16le',
              sample_rate: 16000,
            },
            transcription_config: {
              language: 'hi', // Hindi
              operating_point: 'enhanced',
              enable_partials: true,
              max_delay: 2.0,
            },
          };
          speechmaticsSocket!.send(JSON.stringify(startMessage));
          console.log('[relay] Sent StartRecognition');
        };

        speechmaticsSocket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('[relay] Speechmatics message:', data.message);

            if (data.message === 'RecognitionStarted') {
              isConnected = true;
              clientSocket.send(JSON.stringify({ type: 'connected' }));
            } else if (data.message === 'AddPartialTranscript') {
              // Send partial transcript to client
              const text = data.results
                ?.map((r: any) => r.alternatives?.[0]?.content || '')
                .join(' ')
                .trim();
              if (text) {
                clientSocket.send(JSON.stringify({ type: 'partial', text }));
              }
            } else if (data.message === 'AddTranscript') {
              // Send final transcript to client
              const text = data.results
                ?.map((r: any) => r.alternatives?.[0]?.content || '')
                .join(' ')
                .trim();
              if (text) {
                clientSocket.send(JSON.stringify({ type: 'final', text }));
              }
            } else if (data.message === 'EndOfTranscript') {
              clientSocket.send(JSON.stringify({ type: 'end' }));
            } else if (data.message === 'Error') {
              console.error('[relay] Speechmatics error:', data);
              clientSocket.send(JSON.stringify({ type: 'error', error: data.reason || 'Unknown error' }));
            }
          } catch (err) {
            console.error('[relay] Parse error:', err);
          }
        };

        speechmaticsSocket.onerror = (err) => {
          console.error('[relay] Speechmatics WebSocket error:', err);
          clientSocket.send(JSON.stringify({ type: 'error', error: 'Connection error' }));
        };

        speechmaticsSocket.onclose = (event) => {
          console.log('[relay] Speechmatics closed:', event.code, event.reason);
          isConnected = false;
          try {
            clientSocket.send(JSON.stringify({ type: 'disconnected' }));
          } catch {
            // Client may already be closed
          }
        };
      } catch (err) {
        console.error('[relay] JWT generation failed:', err);
        clientSocket.send(JSON.stringify({ type: 'error', error: 'Authentication failed' }));
        clientSocket.close();
      }
    };

    clientSocket.onmessage = (event) => {
      if (!speechmaticsSocket || !isConnected) {
        console.log('[relay] Ignoring message, not connected');
        return;
      }

      // Check if it's binary audio data
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        // Forward audio directly to Speechmatics
        speechmaticsSocket.send(event.data);
      } else {
        // Handle text messages (control messages)
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'stop') {
            // Send EndOfStream to Speechmatics
            speechmaticsSocket.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: msg.seq || 0 }));
          }
        } catch {
          // Might be raw string audio data encoded differently
          console.log('[relay] Unexpected text message');
        }
      }
    };

    clientSocket.onerror = (err) => {
      console.error('[relay] Client WebSocket error:', err);
    };

    clientSocket.onclose = () => {
      console.log('[relay] Client disconnected');
      if (speechmaticsSocket) {
        try {
          speechmaticsSocket.close();
        } catch {
          // Ignore
        }
      }
    };

    return response;
  }

  // Non-WebSocket request - return info
  return new Response(
    JSON.stringify({ message: 'Speechmatics real-time relay. Connect via WebSocket.' }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
