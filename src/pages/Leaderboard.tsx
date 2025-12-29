import { useEffect, useState } from 'react';
import { Layout } from '@/components/layout/Layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScoreDisplay } from '@/components/karaoke/ScoreDisplay';
import { supabase } from '@/integrations/supabase/client';
import { Trophy, Medal, Award, Music } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface LeaderboardEntry {
  id: string;
  username: string;
  total_score: number;
  songs_performed: number;
  avatar_url: string | null;
}

interface TopScore {
  id: string;
  score: number;
  rating: string;
  song_title: string;
  song_artist: string | null;
  thumbnail_url: string | null;
  profiles: {
    username: string;
  } | null;
}

export default function Leaderboard() {
  const [topUsers, setTopUsers] = useState<LeaderboardEntry[]>([]);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLeaderboard = async () => {
      setLoading(true);
      
      // Fetch top users by total score
      const { data: users, error: usersError } = await supabase
        .from('profiles')
        .select('id, username, total_score, songs_performed, avatar_url')
        .order('total_score', { ascending: false })
        .limit(10);

      if (!usersError && users) {
        setTopUsers(users);
      }

      // Fetch top individual scores
      const { data: scores, error: scoresError } = await supabase
        .from('scores')
        .select(`
          id,
          score,
          rating,
          song_title,
          song_artist,
          thumbnail_url,
          profiles!scores_user_id_fkey (username)
        `)
        .order('score', { ascending: false })
        .limit(10);

      if (!scoresError && scores) {
        setTopScores(scores as unknown as TopScore[]);
      }

      setLoading(false);
    };

    fetchLeaderboard();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('leaderboard-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
        fetchLeaderboard();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' }, () => {
        fetchLeaderboard();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getRankIcon = (index: number) => {
    switch (index) {
      case 0:
        return <Trophy className="h-6 w-6 text-score-s" />;
      case 1:
        return <Medal className="h-6 w-6 text-muted-foreground" />;
      case 2:
        return <Award className="h-6 w-6 text-score-c" />;
      default:
        return <span className="font-display text-lg font-bold text-muted-foreground">{index + 1}</span>;
    }
  };

  return (
    <Layout>
      <div className="space-y-8">
        <div className="text-center">
          <h1 className="font-display text-3xl font-bold mb-2">Leaderboard</h1>
          <p className="text-muted-foreground">Top performers from around the world</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Top Users */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-score-s" />
                Top Performers
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? (
                Array(5).fill(0).map((_, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <Skeleton className="h-6 w-6" />
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-24 mb-1" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                    <Skeleton className="h-6 w-16" />
                  </div>
                ))
              ) : topUsers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Music className="h-12 w-12 mx-auto mb-4 opacity-30" />
                  <p>No scores yet. Be the first!</p>
                </div>
              ) : (
                topUsers.map((user, index) => (
                  <div
                    key={user.id}
                    className={`flex items-center gap-4 p-3 rounded-xl transition-colors ${
                      index < 3 ? 'bg-muted/50' : ''
                    }`}
                  >
                    <div className="w-8 flex justify-center">
                      {getRankIcon(index)}
                    </div>
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className={index === 0 ? 'gradient-primary text-primary-foreground' : ''}>
                        {user.username.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="font-medium">{user.username}</div>
                      <div className="text-sm text-muted-foreground">
                        {user.songs_performed} songs
                      </div>
                    </div>
                    <div className="font-display text-lg font-bold">
                      {user.total_score.toLocaleString()}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Top Scores */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Music className="h-5 w-5 text-primary" />
                Top Scores
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? (
                Array(5).fill(0).map((_, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <Skeleton className="h-6 w-6" />
                    <Skeleton className="h-12 w-12 rounded-lg" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-32 mb-1" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                    <Skeleton className="h-8 w-16" />
                  </div>
                ))
              ) : topScores.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Music className="h-12 w-12 mx-auto mb-4 opacity-30" />
                  <p>No scores yet. Be the first!</p>
                </div>
              ) : (
                topScores.map((score, index) => (
                  <div
                    key={score.id}
                    className={`flex items-center gap-4 p-3 rounded-xl transition-colors ${
                      index < 3 ? 'bg-muted/50' : ''
                    }`}
                  >
                    <div className="w-8 flex justify-center">
                      {getRankIcon(index)}
                    </div>
                    {score.thumbnail_url && (
                      <img
                        src={score.thumbnail_url}
                        alt={score.song_title}
                        className="h-12 w-12 rounded-lg object-cover"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{score.song_title}</div>
                      <div className="text-sm text-muted-foreground">
                        by {score.profiles?.username || 'Anonymous'}
                      </div>
                    </div>
                    <ScoreDisplay score={score.score} rating={score.rating} size="sm" />
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
