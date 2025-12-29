import { Link } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Mic, Trophy, History, Play, Music, Zap } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

const Index = () => {
  const { user } = useAuth();

  const features = [
    {
      icon: Music,
      title: 'YouTube Integration',
      description: 'Search and play any song from YouTube as your backing track',
    },
    {
      icon: Zap,
      title: 'Real-time Scoring',
      description: 'Get instant feedback on your rhythm and timing as you sing',
    },
    {
      icon: Trophy,
      title: 'Global Leaderboard',
      description: 'Compete with singers worldwide and climb the rankings',
    },
  ];

  return (
    <Layout>
      <div className="space-y-16">
        {/* Hero Section */}
        <section className="relative overflow-hidden rounded-3xl gradient-primary p-8 md:p-16">
          <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg%20width%3D%2260%22%20height%3D%2260%22%20viewBox%3D%220%200%2060%2060%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cg%20fill%3D%22none%22%20fill-rule%3D%22evenodd%22%3E%3Cg%20fill%3D%22%23ffffff%22%20fill-opacity%3D%220.1%22%3E%3Cpath%20d%3D%22M36%2034v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6%2034v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6%204V0H4v4H0v2h4v4h2V6h4V4H6z%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3C%2Fsvg%3E')] opacity-30"></div>
          <div className="relative z-10 flex flex-col items-center text-center text-primary-foreground">
            <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-primary-foreground/20 backdrop-blur-sm animate-float">
              <Mic className="h-12 w-12" />
            </div>
            <h1 className="font-display text-4xl font-bold md:text-6xl mb-4">
              Sing. Score. Shine.
            </h1>
            <p className="max-w-2xl text-lg md:text-xl opacity-90 mb-8">
              Transform your singing sessions into a competitive experience. 
              Get real-time rhythm scoring and compete with singers around the world.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link to="/sing">
                <Button size="lg" variant="secondary" className="gap-2 text-lg px-8">
                  <Play className="h-5 w-5" />
                  Start Singing
                </Button>
              </Link>
              {!user && (
                <Link to="/auth">
                  <Button size="lg" variant="outline" className="gap-2 text-lg px-8 bg-transparent border-primary-foreground/30 text-primary-foreground hover:bg-primary-foreground/10">
                    Create Account
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section className="space-y-8">
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold mb-4">How It Works</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Our advanced audio analysis tracks your rhythm and timing in real-time, 
              giving you instant feedback as you perform.
            </p>
          </div>
          
          <div className="grid gap-6 md:grid-cols-3">
            {features.map((feature, index) => (
              <Card key={index} className="group hover:shadow-glow transition-all duration-300 animate-fade-in" style={{ animationDelay: `${index * 100}ms` }}>
                <CardContent className="p-6 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl gradient-primary group-hover:animate-pulse-glow transition-all">
                    <feature.icon className="h-7 w-7 text-primary-foreground" />
                  </div>
                  <h3 className="font-display text-xl font-semibold mb-2">{feature.title}</h3>
                  <p className="text-muted-foreground">{feature.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Quick Actions */}
        <section className="grid gap-4 md:grid-cols-2">
          <Link to="/leaderboard" className="group">
            <Card className="h-full hover:shadow-glow transition-all duration-300 overflow-hidden">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-score-s/20 text-score-s">
                  <Trophy className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-display text-xl font-semibold group-hover:text-primary transition-colors">
                    View Leaderboard
                  </h3>
                  <p className="text-muted-foreground">See who's topping the charts</p>
                </div>
              </CardContent>
            </Card>
          </Link>
          
          <Link to="/history" className="group">
            <Card className="h-full hover:shadow-glow transition-all duration-300 overflow-hidden">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/20 text-accent">
                  <History className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-display text-xl font-semibold group-hover:text-primary transition-colors">
                    Your History
                  </h3>
                  <p className="text-muted-foreground">Track your progress over time</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        </section>
      </div>
    </Layout>
  );
};

export default Index;
