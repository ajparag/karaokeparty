import { useEffect, useState } from 'react';
import { Star, Sparkles, Trophy, Medal, Award, ThumbsUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CelebrationOverlayProps {
  isVisible: boolean;
  rating: string;
  score: number;
  onComplete?: () => void;
}

const messages: Record<string, { title: string; subtitle: string; icon: React.ElementType }> = {
  L: { title: 'LEGENDARY!', subtitle: 'You are a superstar!', icon: Trophy },
  S: { title: 'SUPERB!', subtitle: 'Outstanding performance!', icon: Star },
  A: { title: 'AMAZING!', subtitle: 'You nailed it!', icon: Medal },
  B: { title: 'GREAT JOB!', subtitle: 'Impressive skills!', icon: Award },
  C: { title: 'NICE WORK!', subtitle: 'Keep practicing!', icon: ThumbsUp },
  D: { title: 'GOOD EFFORT!', subtitle: 'You can do better!', icon: ThumbsUp },
  F: { title: 'KEEP TRYING!', subtitle: 'Practice makes perfect!', icon: Sparkles },
};

export function CelebrationOverlay({ isVisible, rating, score, onComplete }: CelebrationOverlayProps) {
  const [confetti, setConfetti] = useState<Array<{ id: number; x: number; color: string; delay: number; size: number }>>([]);
  const [showContent, setShowContent] = useState(false);

  const message = messages[rating] || messages.C;
  const Icon = message.icon;

  useEffect(() => {
    if (isVisible) {
      // Generate confetti particles
      const particles = Array.from({ length: rating === 'S' || rating === 'A' ? 50 : 20 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        color: ['hsl(var(--primary))', 'hsl(var(--accent))', 'hsl(45, 95%, 55%)', 'hsl(280, 90%, 60%)'][Math.floor(Math.random() * 4)],
        delay: Math.random() * 0.5,
        size: Math.random() * 8 + 4,
      }));
      setConfetti(particles);

      // Show content with delay
      const timer = setTimeout(() => setShowContent(true), 200);
      
      // Trigger onComplete after animation
      const completeTimer = setTimeout(() => {
        onComplete?.();
      }, 3000);

      return () => {
        clearTimeout(timer);
        clearTimeout(completeTimer);
      };
    } else {
      setShowContent(false);
      setConfetti([]);
    }
  }, [isVisible, rating, onComplete]);

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none overflow-hidden">
      {/* Background overlay */}
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" />

      {/* Confetti */}
      {confetti.map((particle) => (
        <div
          key={particle.id}
          className="absolute animate-confetti"
          style={{
            left: `${particle.x}%`,
            top: '-20px',
            width: particle.size,
            height: particle.size,
            backgroundColor: particle.color,
            borderRadius: Math.random() > 0.5 ? '50%' : '2px',
            animationDelay: `${particle.delay}s`,
          }}
        />
      ))}

      {/* Main content */}
      {showContent && (
        <div className="relative z-10 text-center space-y-6">
          {/* Icon with glow */}
          <div className="animate-bounce-in">
            <div className={cn(
              "inline-flex items-center justify-center w-24 h-24 rounded-full",
              "bg-gradient-to-br from-primary to-accent shadow-glow",
              rating === 'S' && "animate-pulse-glow"
            )}>
              <Icon className="w-12 h-12 text-primary-foreground" />
            </div>
          </div>

          {/* Title */}
          <div 
            className="animate-celebration"
            style={{ animationDelay: '0.2s' }}
          >
            <h1 className={cn(
              "text-5xl md:text-7xl font-display font-bold",
              "bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent"
            )}>
              {message.title}
            </h1>
          </div>

          {/* Subtitle */}
          <div 
            className="animate-celebration"
            style={{ animationDelay: '0.4s' }}
          >
            <p className="text-xl md:text-2xl text-muted-foreground">
              {message.subtitle}
            </p>
          </div>

          {/* Score */}
          <div 
            className="animate-bounce-in"
            style={{ animationDelay: '0.6s' }}
          >
            <div className="inline-block px-8 py-4 rounded-2xl bg-card/80 backdrop-blur border border-border">
              <div className="text-4xl md:text-6xl font-display font-bold tabular-nums">
                {score.toLocaleString()}
              </div>
              <div className="text-muted-foreground">points</div>
            </div>
          </div>

          {/* Floating stars for S/A ratings */}
          {(rating === 'S' || rating === 'A') && (
            <>
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="absolute animate-star-burst"
                  style={{
                    left: `${20 + i * 15}%`,
                    top: `${30 + (i % 2) * 40}%`,
                    animationDelay: `${0.8 + i * 0.2}s`,
                  }}
                >
                  <Star className="w-8 h-8 text-yellow-400 fill-yellow-400" />
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
