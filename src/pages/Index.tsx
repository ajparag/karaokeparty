import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Mic, Music, Trophy, Sparkles } from "lucide-react";

const Index = () => {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Hero Section */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 relative overflow-hidden">
        {/* Background effects */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-secondary/20 rounded-full blur-3xl" />
        </div>
        
        {/* Content */}
        <div className="relative z-10 text-center max-w-4xl mx-auto">
          {/* Logo/Title */}
          <div className="mb-8 flex items-center justify-center gap-3">
            <div className="p-4 rounded-2xl gradient-primary shadow-glow">
              <Mic className="w-10 h-10 text-primary-foreground" />
            </div>
          </div>
          
          <h1 className="text-5xl md:text-7xl font-bold mb-6 tracking-tight">
            <span className="text-gradient">गाओ</span>
            <span className="text-foreground"> Karaoke</span>
          </h1>
          
          <p className="text-xl md:text-2xl text-muted-foreground mb-4 font-medium">
            Sing Bollywood, Tollywood & More
          </p>
          
          <p className="text-muted-foreground mb-12 max-w-2xl mx-auto">
            Your ultimate Indian karaoke experience. Search instrumental tracks, 
            follow synced lyrics, and get scored on your vocal performance.
          </p>
          
          {/* Language badges */}
          <div className="flex flex-wrap justify-center gap-2 mb-12">
            {['Hindi', 'Marathi', 'Gujarati', 'Punjabi', 'Tamil', 'Telugu', 'Malayalam'].map((lang) => (
              <span key={lang} className="language-badge text-muted-foreground">
                {lang}
              </span>
            ))}
          </div>
          
          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link to="/search">
              <Button size="lg" className="gradient-primary text-primary-foreground shadow-glow hover:opacity-90 transition-opacity px-8 py-6 text-lg">
                <Music className="w-5 h-5 mr-2" />
                Start Singing
              </Button>
            </Link>
            <Link to="/leaderboard">
              <Button size="lg" variant="outline" className="px-8 py-6 text-lg border-border hover:bg-muted">
                <Trophy className="w-5 h-5 mr-2" />
                Leaderboard
              </Button>
            </Link>
          </div>
        </div>
      </div>
      
      {/* Features Section */}
      <div className="py-16 px-4 border-t border-border">
        <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-8">
          <FeatureCard
            icon={<Music className="w-8 h-8" />}
            title="Vast Music Library"
            description="Search thousands of Bollywood, Tollywood, and regional instrumental tracks from Gaana & JioSaavn"
          />
          <FeatureCard
            icon={<Sparkles className="w-8 h-8" />}
            title="Real-time Scoring"
            description="Get scored on pitch accuracy, rhythm, and diction as you sing with visual feedback"
          />
          <FeatureCard
            icon={<Trophy className="w-8 h-8" />}
            title="Compete & Share"
            description="Track your performance history, climb the leaderboard, and challenge friends"
          />
        </div>
      </div>
      
      {/* Footer */}
      <footer className="py-6 px-4 border-t border-border text-center text-muted-foreground text-sm">
        <p>Built with ❤️ for Indian music lovers</p>
      </footer>
    </div>
  );
};

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const FeatureCard = ({ icon, title, description }: FeatureCardProps) => (
  <div className="p-6 rounded-xl bg-card border border-border hover:border-primary/50 transition-colors">
    <div className="w-14 h-14 rounded-xl gradient-primary flex items-center justify-center text-primary-foreground mb-4">
      {icon}
    </div>
    <h3 className="text-xl font-semibold mb-2">{title}</h3>
    <p className="text-muted-foreground">{description}</p>
  </div>
);

export default Index;
