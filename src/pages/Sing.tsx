import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { YouTubeSearch } from '@/components/karaoke/YouTubeSearch';
import { YouTubePlayer } from '@/components/karaoke/YouTubePlayer';
import { PitchVisualizer } from '@/components/karaoke/PitchVisualizer';
import { ScoreDisplay } from '@/components/karaoke/ScoreDisplay';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, Mic, Trophy, Timer } from 'lucide-react';

interface SelectedVideo {
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
}

export default function Sing() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo | null>(null);
  const [isPerforming, setIsPerforming] = useState(false);
  const [currentScore, setCurrentScore] = useState(0);
  const [rhythmConsistency, setRhythmConsistency] = useState(0);
  const [performanceTime, setPerformanceTime] = useState(0);
  const [showResults, setShowResults] = useState(false);
  
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const scoreHistoryRef = useRef<number[]>([]);

  const handleSelectVideo = useCallback((video: SelectedVideo) => {
    setSelectedVideo(video);
    setShowResults(false);
    setCurrentScore(0);
    setRhythmConsistency(0);
    setPerformanceTime(0);
    scoreHistoryRef.current = [];
  }, []);

  const handlePlay = useCallback(() => {
    setIsPerforming(true);
    setShowResults(false);
    
    // Start timer
    timerRef.current = setInterval(() => {
      setPerformanceTime(prev => prev + 1);
    }, 1000);
  }, []);

  const handlePause = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
  }, []);

  const handleEnd = useCallback(async () => {
    setIsPerforming(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    
    // Calculate final score
    const avgScore = scoreHistoryRef.current.length > 0
      ? Math.round(scoreHistoryRef.current.reduce((a, b) => a + b, 0) / scoreHistoryRef.current.length)
      : currentScore;
    
    setCurrentScore(avgScore);
    setShowResults(true);
    
    // Save score if user is logged in
    if (user && selectedVideo && performanceTime > 10) {
      const rating = avgScore >= 95 ? 'S' : avgScore >= 85 ? 'A' : avgScore >= 70 ? 'B' : avgScore >= 55 ? 'C' : avgScore >= 40 ? 'D' : 'F';
      
      const { error } = await supabase.from('scores').insert({
        user_id: user.id,
        song_title: selectedVideo.title,
        song_artist: selectedVideo.channel,
        youtube_video_id: selectedVideo.id,
        thumbnail_url: selectedVideo.thumbnail,
        score: avgScore,
        rating,
        rhythm_accuracy: rhythmConsistency,
        timing_accuracy: rhythmConsistency,
        duration_seconds: performanceTime,
      });
      
      if (error) {
        console.error('Error saving score:', error);
        toast({
          title: 'Score Not Saved',
          description: 'There was an error saving your score.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Score Saved!',
          description: `Your score of ${avgScore} has been recorded.`,
        });
      }
    }
  }, [user, selectedVideo, performanceTime, currentScore, rhythmConsistency, toast]);

  const handleRhythmData = useCallback((data: { beatStrength: number; consistency: number }) => {
    // Update score based on rhythm consistency
    const newScore = Math.round(data.consistency);
    setRhythmConsistency(data.consistency);
    setCurrentScore(prev => Math.round((prev * 0.9) + (newScore * 0.1)));
    scoreHistoryRef.current.push(newScore);
    
    // Keep only last 100 scores
    if (scoreHistoryRef.current.length > 100) {
      scoreHistoryRef.current.shift();
    }
  }, []);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <Layout>
      <div className="space-y-6">
        {!selectedVideo ? (
          <>
            <div className="text-center mb-8">
              <h1 className="font-display text-3xl font-bold mb-2">Find Your Song</h1>
              <p className="text-muted-foreground">
                Search for a karaoke or instrumental version to sing along
              </p>
            </div>
            <YouTubeSearch onSelectVideo={handleSelectVideo} />
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              onClick={() => setSelectedVideo(null)}
              className="mb-4"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Choose Different Song
            </Button>

            <div className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2 space-y-6">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg">{selectedVideo.title}</CardTitle>
                    <p className="text-sm text-muted-foreground">{selectedVideo.channel}</p>
                  </CardHeader>
                  <CardContent>
                    <YouTubePlayer
                      videoId={selectedVideo.id}
                      onPlay={handlePlay}
                      onPause={handlePause}
                      onEnd={handleEnd}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Mic className="h-5 w-5 text-primary" />
                      Voice Visualizer
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <PitchVisualizer
                      isActive={isPerforming}
                      onRhythmData={handleRhythmData}
                    />
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-6">
                <Card className="overflow-hidden">
                  <div className="gradient-primary p-6 text-primary-foreground">
                    <div className="flex items-center gap-2 mb-4">
                      <Trophy className="h-5 w-5" />
                      <span className="font-medium">Current Score</span>
                    </div>
                    <ScoreDisplay score={currentScore} size="lg" showRating={isPerforming || showResults} />
                  </div>
                  <CardContent className="p-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-2">
                        <Timer className="h-4 w-4" />
                        Time
                      </span>
                      <span className="font-display text-xl font-bold">{formatTime(performanceTime)}</span>
                    </div>
                    
                    <div>
                      <div className="flex justify-between mb-2">
                        <span className="text-sm text-muted-foreground">Rhythm Consistency</span>
                        <span className="text-sm font-medium">{Math.round(rhythmConsistency)}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div 
                          className="h-full gradient-accent transition-all duration-300"
                          style={{ width: `${rhythmConsistency}%` }}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {showResults && (
                  <Card className="animate-scale-in">
                    <CardContent className="p-6 text-center">
                      <h3 className="font-display text-xl font-bold mb-4">Performance Complete!</h3>
                      <ScoreDisplay score={currentScore} size="md" />
                      <div className="mt-6 space-y-2">
                        <Button className="w-full gradient-primary" onClick={() => setSelectedVideo(null)}>
                          Sing Another Song
                        </Button>
                        {user && (
                          <Button variant="outline" className="w-full" onClick={() => navigate('/history')}>
                            View History
                          </Button>
                        )}
                        {!user && (
                          <Button variant="outline" className="w-full" onClick={() => navigate('/auth')}>
                            Sign In to Save Scores
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {!user && !showResults && (
                  <Card className="border-primary/20 bg-primary/5">
                    <CardContent className="p-4 text-center">
                      <p className="text-sm text-muted-foreground mb-2">
                        Sign in to save your scores and compete on the leaderboard
                      </p>
                      <Button variant="outline" size="sm" onClick={() => navigate('/auth')}>
                        Sign In
                      </Button>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
