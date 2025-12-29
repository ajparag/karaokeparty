import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScoreDisplay } from '@/components/karaoke/ScoreDisplay';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Music, Calendar, Clock, Trash2, TrendingUp } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { format } from 'date-fns';

interface ScoreEntry {
  id: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  score: number;
  rating: string;
  rhythm_accuracy: number | null;
  duration_seconds: number | null;
  created_at: string;
}

export default function History() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalSongs: 0,
    averageScore: 0,
    bestScore: 0,
    totalTime: 0,
  });

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
      return;
    }

    if (user) {
      fetchScores();
    }
  }, [user, authLoading, navigate]);

  const fetchScores = async () => {
    if (!user) return;

    setLoading(true);
    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setScores(data);
      
      // Calculate stats
      if (data.length > 0) {
        const totalScore = data.reduce((sum, s) => sum + s.score, 0);
        const totalTime = data.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
        setStats({
          totalSongs: data.length,
          averageScore: Math.round(totalScore / data.length),
          bestScore: Math.max(...data.map(s => s.score)),
          totalTime,
        });
      }
    }
    setLoading(false);
  };

  const deleteScore = async (id: string) => {
    const { error } = await supabase.from('scores').delete().eq('id', id);
    
    if (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete score.',
        variant: 'destructive',
      });
    } else {
      setScores(scores.filter(s => s.id !== id));
      toast({
        title: 'Score Deleted',
        description: 'The score has been removed from your history.',
      });
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (authLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="animate-pulse text-muted-foreground">Loading...</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-8">
        <div className="text-center">
          <h1 className="font-display text-3xl font-bold mb-2">Your History</h1>
          <p className="text-muted-foreground">Track your singing journey</p>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Music className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <div className="text-2xl font-display font-bold">{stats.totalSongs}</div>
                  <div className="text-sm text-muted-foreground">Songs Performed</div>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-accent/10 flex items-center justify-center">
                  <TrendingUp className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <div className="text-2xl font-display font-bold">{stats.averageScore}</div>
                  <div className="text-sm text-muted-foreground">Average Score</div>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-score-s/10 flex items-center justify-center">
                  <TrendingUp className="h-5 w-5 text-score-s" />
                </div>
                <div>
                  <div className="text-2xl font-display font-bold">{stats.bestScore}</div>
                  <div className="text-sm text-muted-foreground">Best Score</div>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <div className="text-2xl font-display font-bold">{formatDuration(stats.totalTime)}</div>
                  <div className="text-sm text-muted-foreground">Total Time</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Score History */}
        <Card>
          <CardHeader>
            <CardTitle>Performance History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              Array(3).fill(0).map((_, i) => (
                <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-muted/30">
                  <Skeleton className="h-16 w-16 rounded-lg" />
                  <div className="flex-1">
                    <Skeleton className="h-5 w-48 mb-2" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                  <Skeleton className="h-10 w-20" />
                </div>
              ))
            ) : scores.length === 0 ? (
              <div className="text-center py-12">
                <Music className="h-16 w-16 text-muted-foreground/30 mx-auto mb-4" />
                <h3 className="font-display text-xl font-semibold mb-2">No performances yet</h3>
                <p className="text-muted-foreground mb-4">Start singing to build your history!</p>
                <Button onClick={() => navigate('/sing')} className="gradient-primary">
                  Start Singing
                </Button>
              </div>
            ) : (
              scores.map((score) => (
                <div
                  key={score.id}
                  className="flex items-center gap-4 p-4 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  {score.thumbnail_url ? (
                    <img
                      src={score.thumbnail_url}
                      alt={score.song_title}
                      className="h-16 w-16 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="h-16 w-16 rounded-lg bg-muted flex items-center justify-center">
                      <Music className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                  
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium truncate">{score.song_title}</h3>
                    {score.song_artist && (
                      <p className="text-sm text-muted-foreground">{score.song_artist}</p>
                    )}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(score.created_at), 'MMM d, yyyy')}
                      </span>
                      {score.duration_seconds && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(score.duration_seconds)}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <ScoreDisplay score={score.score} rating={score.rating} size="sm" />
                  
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this score?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This action cannot be undone. This will permanently delete this performance from your history.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteScore(score.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
