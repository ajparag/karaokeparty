import { useState, useRef, useCallback, useEffect } from 'react';
import { Layout } from '@/components/layout/Layout';
import { YouTubeSearch, VideoResult } from '@/components/karaoke/YouTubeSearch';
import { YouTubePlayer } from '@/components/karaoke/YouTubePlayer';
import { PitchVisualizer } from '@/components/karaoke/PitchVisualizer';
import { ScoreDisplay } from '@/components/karaoke/ScoreDisplay';
import { FloatingScore } from '@/components/karaoke/FloatingScore';
import { CelebrationOverlay } from '@/components/karaoke/CelebrationOverlay';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Play, Pause, RotateCcw, Mic, Maximize, Minimize, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function Sing() {
  const { user } = useAuth();
  const [selectedVideo, setSelectedVideo] = useState<VideoResult | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentScore, setCurrentScore] = useState(0);
  const [rhythmConsistency, setRhythmConsistency] = useState(0);
  const [pitchAccuracy, setPitchAccuracy] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [performanceTime, setPerformanceTime] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [remainingTime, setRemainingTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const scoreHistoryRef = useRef<number[]>([]);
  const performanceStartRef = useRef<number | null>(null);

  const handleSelectVideo = useCallback((video: VideoResult) => {
    setSelectedVideo(video);
    setCurrentScore(0);
    setRhythmConsistency(0);
    setPitchAccuracy(0);
    setShowResults(false);
    setShowCelebration(false);
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

  const calculateRating = (score: number) => {
    if (score >= 950) return 'S';
    if (score >= 850) return 'A';
    if (score >= 700) return 'B';
    if (score >= 550) return 'C';
    if (score >= 400) return 'D';
    return 'F';
  };

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
    
    // Show celebration first
    setShowCelebration(true);
    
    // Save score if user is logged in
    if (user && selectedVideo && performanceTime > 10) {
      const rating = calculateRating(avgScore);
      
      const { error } = await supabase.from('scores').insert({
        user_id: user.id,
        song_title: selectedVideo.title,
        song_artist: selectedVideo.channel,
        youtube_video_id: selectedVideo.id,
        thumbnail_url: selectedVideo.thumbnail,
        score: avgScore,
        rating,
        rhythm_accuracy: rhythmConsistency,
        timing_accuracy: pitchAccuracy,
        duration_seconds: performanceTime,
      });

      if (error) {
        console.error('Error saving score:', error);
        toast.error('Failed to save score');
      } else {
        toast.success('Score saved!');
      }
    }
  }, [user, selectedVideo, performanceTime, currentScore, rhythmConsistency, pitchAccuracy]);

  const handleCelebrationComplete = useCallback(() => {
    setShowCelebration(false);
    setShowResults(true);
  }, []);

  const handleRhythmData = useCallback((data: { beatStrength: number; consistency: number; pitchAccuracy: number }) => {
    // Combined score: 50% rhythm + 50% pitch (values come as 0-100)
    const combinedAccuracy = (data.consistency + data.pitchAccuracy) / 2;
    // Scale to 1000-point system
    const newScore = Math.round(combinedAccuracy * 10);
    
    setRhythmConsistency(data.consistency);
    setPitchAccuracy(data.pitchAccuracy);
    
    // Smooth score update - blend new score with history
    setCurrentScore(prevScore => {
      const blendedScore = Math.round((prevScore * 0.7) + (newScore * 0.3));
      return Math.min(1000, Math.max(0, blendedScore));
    });
    
    scoreHistoryRef.current.push(newScore);
    
    // Keep only last 100 scores
    if (scoreHistoryRef.current.length > 100) {
      scoreHistoryRef.current.shift();
    }
  }, []);

  const handleTimeUpdate = useCallback((currentTime: number, duration: number) => {
    setVideoDuration(duration);
    setRemainingTime(Math.max(0, duration - currentTime));
  }, []);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleRestart = useCallback(() => {
    setCurrentScore(0);
    setRhythmConsistency(0);
    setPitchAccuracy(0);
    setShowResults(false);
    setShowCelebration(false);
    scoreHistoryRef.current = [];
    performanceStartRef.current = null;
    setIsPlaying(false);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      fullscreenRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
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
              {selectedVideo ? 'Follow along and keep the rhythm!' : 'Paste a YouTube link to your favorite karaoke song to get started'}
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
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleFullscreen}
                      className="gap-2"
                    >
                      <Maximize className="h-4 w-4" />
                      Fullscreen
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedVideo(null)}
                    >
                      Change Song
                    </Button>
                  </div>
                </div>
              </Card>

              {/* Celebration Overlay */}
              <CelebrationOverlay
                isVisible={showCelebration}
                rating={calculateRating(currentScore)}
                score={currentScore}
                onComplete={handleCelebrationComplete}
              />

              {/* Results Overlay */}
              {showResults ? (
                <Card className="glass-card">
                  <CardContent className="p-8 text-center space-y-6">
                    <h2 className="text-2xl font-display font-bold">Performance Complete!</h2>
                    <div className="flex justify-center">
                      <ScoreDisplay score={currentScore} size="lg" />
                    </div>
                    <div className="grid grid-cols-3 gap-4 max-w-md mx-auto">
                      <div className="p-4 bg-muted/30 rounded-lg">
                        <div className="text-2xl font-bold">{Math.round(pitchAccuracy)}%</div>
                        <div className="text-sm text-muted-foreground">Pitch</div>
                      </div>
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
                <div
                  ref={fullscreenRef}
                  className={cn(
                    "space-y-4",
                    isFullscreen && "fixed inset-0 z-50 bg-background flex flex-col"
                  )}
                >
                  {/* Fullscreen Header */}
                  {isFullscreen && (
                    <div className="flex items-center justify-between px-4 pt-4 flex-shrink-0">
                      <h2 className="font-semibold text-lg line-clamp-1">{selectedVideo.title}</h2>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleFullscreen}
                      >
                        <X className="h-5 w-5" />
                      </Button>
                    </div>
                  )}

                  {/* YouTube Player with Floating Score */}
                  <div className={cn(
                    "relative overflow-hidden bg-black",
                    isFullscreen ? "flex-1 w-full" : "aspect-video rounded-lg"
                  )}>
                    <YouTubePlayer
                      videoId={selectedVideo.id}
                      onPlay={handlePlay}
                      onPause={handlePause}
                      onEnd={handleEnd}
                      onTimeUpdate={handleTimeUpdate}
                    />
                    
                    {/* Floating Score Widget */}
                    {isPlaying && (
                      <div className="absolute top-4 right-4 z-10">
                        <FloatingScore
                          score={currentScore}
                          pitchAccuracy={pitchAccuracy}
                          rhythmAccuracy={rhythmConsistency}
                        />
                      </div>
                    )}

                    {/* Remaining Time Display */}
                    {isPlaying && remainingTime > 0 && (
                      <div className="absolute bottom-4 left-4 z-10 bg-black/70 px-3 py-1.5 rounded-lg text-white text-sm font-medium">
                        {formatTime(remainingTime)} remaining
                      </div>
                    )}
                  </div>

                  {/* Score Display - Only in normal mode */}
                  {!isFullscreen && (
                    <Card className="glass-card">
                      <CardContent className="p-6 space-y-4">
                        <div className="flex items-center justify-center">
                          <ScoreDisplay score={currentScore} size="lg" />
                        </div>

                        {/* Accuracy Meters */}
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="flex justify-between mb-2">
                              <span className="text-sm text-muted-foreground">Pitch Accuracy</span>
                              <span className="text-sm font-medium">{Math.round(pitchAccuracy)}%</span>
                            </div>
                            <div className="h-3 bg-muted rounded-full overflow-hidden">
                              <div 
                                className="h-full gradient-primary transition-all duration-300"
                                style={{ width: `${pitchAccuracy}%` }}
                              />
                            </div>
                          </div>
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
                  )}

                  {/* Bottom Section: Visualizer & Controls (Fullscreen) */}
                  {isFullscreen && (
                    <div className="flex-shrink-0 px-4 pb-4 space-y-4">
                      {/* Remaining Time in Fullscreen */}
                      {remainingTime > 0 && (
                        <div className="text-center text-sm text-muted-foreground">
                          {formatTime(remainingTime)} remaining
                        </div>
                      )}

                      {/* Pitch Visualizer - At Bottom */}
                      <Card className="glass-card">
                        <CardContent className="p-3">
                          <div className="flex items-center gap-3 mb-2">
                            <Mic className="h-4 w-4 text-primary" />
                            <span className="text-sm font-medium">Voice Analysis</span>
                            <div className="flex-1" />
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              <span>Pitch: {Math.round(pitchAccuracy)}%</span>
                              <span>Rhythm: {Math.round(rhythmConsistency)}%</span>
                            </div>
                          </div>
                          <PitchVisualizer 
                            isActive={isPlaying} 
                            onRhythmData={handleRhythmData}
                            compact
                          />
                        </CardContent>
                      </Card>

                      {/* Controls */}
                      <div className="flex justify-center gap-4">
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
                        <Button
                          size="lg"
                          variant="ghost"
                          onClick={toggleFullscreen}
                        >
                          <Minimize className="h-5 w-5" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Visualizer in normal mode */}
                  {!isFullscreen && (
                    <Card className="glass-card">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <Mic className="h-5 w-5 text-primary" />
                            <span className="font-medium">Voice Analysis</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleFullscreen}
                            title="Enter fullscreen"
                          >
                            <Maximize className="h-4 w-4" />
                          </Button>
                        </div>
                        <PitchVisualizer 
                          isActive={isPlaying} 
                          onRhythmData={handleRhythmData}
                        />
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tips */}
          {!selectedVideo && (
            <div className="grid md:grid-cols-3 gap-4">
              {[
                { title: 'Warm Up', desc: 'Start with songs you know well' },
                { title: 'Stay on Beat', desc: 'Rhythm and pitch accuracy boost your score' },
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
