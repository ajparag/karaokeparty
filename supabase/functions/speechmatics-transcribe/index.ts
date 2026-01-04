import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { audio } = await req.json();
    
    if (!audio) {
      console.error('No audio data provided');
      return new Response(
        JSON.stringify({ error: 'No audio data provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const SPEECHMATICS_API_KEY = Deno.env.get('SPEECHMATICS_API_KEY');
    if (!SPEECHMATICS_API_KEY) {
      console.error('SPEECHMATICS_API_KEY not configured');
      return new Response(
        JSON.stringify({ error: 'Speechmatics API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Speechmatics transcribe called, audio base64 length:', audio.length);

    // Decode base64 audio
    const binaryString = atob(audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    console.log('Audio decoded, size:', bytes.length, 'bytes');

    // Create form data for Speechmatics batch API
    const formData = new FormData();
    
    // Add the audio file
    const audioBlob = new Blob([bytes], { type: 'audio/webm' });
    formData.append('data_file', audioBlob, 'audio.webm');
    
    // Add the config - Hindi language
    const config = {
      type: 'transcription',
      transcription_config: {
        language: 'hi', // Hindi
        operating_point: 'enhanced', // Better accuracy
        enable_partials: false,
        max_delay: 2,
      },
    };
    formData.append('config', JSON.stringify(config));

    console.log('Sending to Speechmatics batch API...');

    // Submit job to Speechmatics
    const submitResponse = await fetch('https://asr.api.speechmatics.com/v2/jobs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SPEECHMATICS_API_KEY}`,
      },
      body: formData,
    });

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      console.error('Speechmatics submit error:', submitResponse.status, errorText);
      return new Response(
        JSON.stringify({ error: `Speechmatics API error: ${submitResponse.status}`, details: errorText }),
        { status: submitResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const submitResult = await submitResponse.json();
    const jobId = submitResult.id;
    console.log('Job submitted, ID:', jobId);

    // Poll for job completion (max 30 seconds)
    let transcript = '';
    const maxAttempts = 30;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      
      const statusResponse = await fetch(`https://asr.api.speechmatics.com/v2/jobs/${jobId}`, {
        headers: {
          'Authorization': `Bearer ${SPEECHMATICS_API_KEY}`,
        },
      });

      if (!statusResponse.ok) {
        console.error('Status check failed:', statusResponse.status);
        continue;
      }

      const statusResult = await statusResponse.json();
      console.log('Job status:', statusResult.job?.status);

      if (statusResult.job?.status === 'done') {
        // Get transcript
        const transcriptResponse = await fetch(
          `https://asr.api.speechmatics.com/v2/jobs/${jobId}/transcript?format=txt`,
          {
            headers: {
              'Authorization': `Bearer ${SPEECHMATICS_API_KEY}`,
            },
          }
        );

        if (transcriptResponse.ok) {
          transcript = await transcriptResponse.text();
          console.log('Transcript received:', transcript.substring(0, 100));
        }
        break;
      } else if (statusResult.job?.status === 'rejected' || statusResult.job?.status === 'deleted') {
        console.error('Job failed:', statusResult.job?.status);
        break;
      }
    }

    // Delete the job to clean up
    try {
      await fetch(`https://asr.api.speechmatics.com/v2/jobs/${jobId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${SPEECHMATICS_API_KEY}`,
        },
      });
    } catch (e) {
      console.warn('Failed to delete job:', e);
    }

    return new Response(
      JSON.stringify({ text: transcript.trim() }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Speechmatics transcribe error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
