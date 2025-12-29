import { useState, useRef, useCallback } from 'react';
import { Layout } from '@/components/layout/Layout';
import { YouTubeSearch, VideoResult } from '@/components/karaoke/YouTubeSearch';
import { YouTubePlayer } from '@/components/karaoke/YouTubePlayer';
import { PitchVisualizer } from '@/components/karaoke/PitchVisualizer';
import { ScoreDisplay } from '@/components/karaoke/ScoreDisplay';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Play, Pause, RotateCcw, Mic } from 'lucide-react';

export default function Sing() {
  const { user } = useAuth();
  const [selectedVideo, setSelectedVideo] = useState<VideoResult | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentScore, setCurrentScore] = useState(0);
  const [rhythmConsistency, setRhythmConsistency] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [performanceTime, setPerformanceTime] = useState(0);
  const scoreHistoryRef = useRef<number[]>([]);
  const performanceStartRef = useRef<number | null>(null);

  const handleSelectVideo = useCallback((video: VideoResult) => {
    setSelectedVideo(video);
    setCurrentScore(0);
    setRhythmConsistency(0);
    setShowResults(false);
    scoreHistoryRef.current = [];
    performanceStartRef.current = null;
  }, []);

  const handlePlay = useCallback(() => {
    setIsPlaying(true);
    if (!performanceStartRef.current) {
      performanceStartRef.current = Date.now();
    }
  }, []);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const handleEnd = useCallback(async () => {
    setIsPlaying(false);
    
    if (performanceStartRef.current) {
      const duration = Math.floor((Date.now() - performanceStartRef.current) / 1000);
      setPerformanceTime(duration);
    }
    
    // Calculate final score (out of 1000)
    const avgScore = scoreHistoryRef.current.length > 0
      ? Math.round(scoreHistoryRef.current.reduce((a, b) => a + b, 0) / scoreHistoryRef.current.length)
      : currentScore;
    
    setCurrentScore(avgScore);
    setShowResults(true);
    
    // Save score if user is logged in
    if (user && selectedVideo && performanceTime > 10) {
      // Rating thresholds for 1000-point scale
      const rating = avgScore >= 950 ? 'S' : avgScore >= 850 ? 'A' : avgScore >= 700 ? 'B' : avgScore >= 550 ? 'C' : avgScore >= 400 ? 'D' : 'F';
      
      const { error } = await supabase.from('scores').insert({
        user_id: user.id,
        song_title: selectedVideo.title,
        song_artist: selectedVideo.channel,
        youtube_video_id: selectedVideo.id,
        thumbnail_url: selectedVideo.thumbnail,
        score: avgScore,
        rating,
        rhythm_accuracy: rhythmConsistency,
        duration_seconds: performanceTime,
      });

      if (error) {
        console.error('Error saving score:', error);
        toast.error('Failed to save score');
      } else {
        toast.success('Score saved!');
      }
    }
  }, [user, selectedVideo, performanceTime, currentScore, rhythmConsistency]);

  const handleRhythmData = useCallback((data: { beatStrength: number; consistency: number }) => {
    // Update score based on rhythm consistency (scale to 1000)
    const newScore = Math.round(data.consistency * 10);
    setRhythmConsistency(data.consistency);
    setCurrentScore(prev => Math.round((prev * 0.9) + (newScore * 0.1)));
    scoreHistoryRef.current.push(newScore);
    
    // Keep only last 100 scores
    if (scoreHistoryRef.current.length > 100) {
      scoreHistoryRef.current.shift();
    }
  }, []);

  const handleRestart = useCallback(() => {
    setCurrentScore(0);
    setRhythmConsistency(0);
    setShowResults(false);
    scoreHistoryRef.current = [];
    performanceStartRef.current = null;
    setIsPlaying(false);
  }, []);

  return (
    <Layout>
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Header */}
          <div className="text-center">
            <h1 className="text-4xl font-display font-bold mb-2">
              <span className="gradient-text">Sing Your Heart Out</span>
            </h1>
            <p className="text-muted-foreground">
              {selectedVideo ? 'Follow along and keep the rhythm!' : 'Search for a song to get started'}
            </p>
          </div>

          {/* Search */}
          {!selectedVideo && (
            <Card className="glass-card">
              <CardContent className="p-6">
                <YouTubeSearch onSelectVideo={handleSelectVideo} />
              </CardContent>
            </Card>
          )}

          {/* Player & Visualizer */}
          {selectedVideo && (
            <div className="space-y-6">
              {/* Video Info */}
              <Card className="glass-card overflow-hidden">
                <div className="flex items-start gap-4 p-4">
                  <img
                    src={selectedVideo.thumbnail}
                    alt={selectedVideo.title}
                    className="w-32 h-20 object-cover rounded-lg"
                  />
                  <div className="flex-1 min-w-0">
                    <h2 className="font-semibold text-lg line-clamp-2">{selectedVideo.title}</h2>
                    <p className="text-muted-foreground text-sm">{selectedVideo.channel}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedVideo(null)}
                  >
                    Change Song
                  </Button>
                </div>
              </Card>

              {/* Results Overlay */}
              {showResults ? (
                <Card className="glass-card">
                  <CardContent className="p-8 text-center space-y-6">
                    <h2 className="text-2xl font-display font-bold">Performance Complete!</h2>
                    <div className="flex justify-center">
                      <ScoreDisplay score={currentScore} size="lg" />
                    </div>
                    <div className="grid grid-cols-2 gap-4 max-w-sm mx-auto">
                      <div className="p-4 bg-muted/30 rounded-lg">
                        <div className="text-2xl font-bold">{Math.round(rhythmConsistency)}%</div>
                        <div className="text-sm text-muted-foreground">Rhythm</div>
                      </div>
                      <div className="p-4 bg-muted/30 rounded-lg">
                        <div className="text-2xl font-bold">{performanceTime}s</div>
                        <div className="text-sm text-muted-foreground">Duration</div>
                      </div>
                    </div>
                    <div className="flex gap-4 justify-center">
                      <Button onClick={handleRestart} className="gap-2">
                        <RotateCcw className="h-4 w-4" />
                        Try Again
                      </Button>
                      <Button variant="outline" onClick={() => setSelectedVideo(null)}>
                        New Song
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Pitch Visualizer - Above Video */}
                  <Card className="glass-card">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <Mic className="h-5 w-5 text-primary" />
                        <span className="font-medium">Voice Analysis</span>
                      </div>
                      <PitchVisualizer 
                        isActive={isPlaying} 
                        onRhythmData={handleRhythmData}
                      />
                    </CardContent>
                  </Card>

                  {/* YouTube Player */}
                  <div className="aspect-video rounded-lg overflow-hidden bg-card/50">
                    <YouTubePlayer
                      videoId={selectedVideo.id}
                      onPlay={handlePlay}
                      onPause={handlePause}
                      onEnd={handleEnd}
                    />
                  </div>

                  {/* Score Display - Below Video */}
                  <Card className="glass-card">
                    <CardContent className="p-6 space-y-4">
                      <div className="flex items-center justify-center">
                        <ScoreDisplay score={currentScore} size="lg" />
                      </div>

                      {/* Rhythm Meter */}
                      <div>
                        <div className="flex justify-between mb-2">
                          <span className="text-sm text-muted-foreground">Rhythm Consistency</span>
                          <span className="text-sm font-medium">{Math.round(rhythmConsistency)}%</span>
                        </div>
                        <div className="h-3 bg-muted rounded-full overflow-hidden">
                          <div 
                            className="h-full gradient-accent transition-all duration-300"
                            style={{ width: `${rhythmConsistency}%` }}
                          />
                        </div>
                      </div>

                      {/* Controls */}
                      <div className="flex justify-center gap-4 pt-2">
                        <Button
                          size="lg"
                          onClick={() => setIsPlaying(!isPlaying)}
                          className="gap-2"
                        >
                          {isPlaying ? (
                            <>
                              <Pause className="h-5 w-5" />
                              Pause
                            </>
                          ) : (
                            <>
                              <Play className="h-5 w-5" />
                              Start Singing
                            </>
                          )}
                        </Button>
                        <Button
                          size="lg"
                          variant="outline"
                          onClick={handleEnd}
                        >
                          Finish
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          )}

          {/* Tips */}
          {!selectedVideo && (
            <div className="grid md:grid-cols-3 gap-4">
              {[
                { title: 'Warm Up', desc: 'Start with songs you know well' },
                { title: 'Stay on Beat', desc: 'Rhythm consistency is key to high scores' },
                { title: 'Have Fun', desc: 'The best performances come from enjoying yourself' },
              ].map((tip, i) => (
                <Card key={i} className="glass-card p-4">
                  <h3 className="font-semibold mb-1">{tip.title}</h3>
                  <p className="text-sm text-muted-foreground">{tip.desc}</p>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
