import { cn } from '@/lib/utils';
import { useEffect, useState, useRef } from 'react';

interface ScoreDisplayProps {
  score: number;
  rating?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showRating?: boolean;
}

export function ScoreDisplay({ score, rating, size = 'md', showRating = true }: ScoreDisplayProps) {
  const [displayScore, setDisplayScore] = useState(score);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevScoreRef = useRef(score);

  useEffect(() => {
    if (score !== prevScoreRef.current) {
      setIsAnimating(true);
      
      // Animate the score counting up/down
      const diff = score - displayScore;
      const steps = 20;
      const stepValue = diff / steps;
      let current = displayScore;
      let step = 0;

      const interval = setInterval(() => {
        step++;
        current += stepValue;
        setDisplayScore(Math.round(current));
        
        if (step >= steps) {
          clearInterval(interval);
          setDisplayScore(score);
          setTimeout(() => setIsAnimating(false), 200);
        }
      }, 30);

      prevScoreRef.current = score;
      return () => clearInterval(interval);
    }
  }, [score, displayScore]);

  const getRatingColor = (r: string) => {
    switch (r) {
      case 'S': return 'text-score-s';
      case 'A': return 'text-score-a';
      case 'B': return 'text-score-b';
      case 'C': return 'text-score-c';
      case 'D': return 'text-score-d';
      case 'F': return 'text-score-f';
      default: return 'text-muted-foreground';
    }
  };

  const getRatingBg = (r: string) => {
    switch (r) {
      case 'S': return 'bg-score-s/20 shadow-[0_0_30px_hsl(var(--score-s)/0.4)]';
      case 'A': return 'bg-score-a/20 shadow-[0_0_25px_hsl(var(--score-a)/0.3)]';
      case 'B': return 'bg-score-b/20 shadow-[0_0_20px_hsl(var(--score-b)/0.3)]';
      case 'C': return 'bg-score-c/20';
      case 'D': return 'bg-score-d/20';
      case 'F': return 'bg-score-f/20';
      default: return 'bg-muted';
    }
  };

  // Rating thresholds for 1000-point scale
  const calculateRating = (s: number) => {
    if (s >= 950) return 'S';
    if (s >= 850) return 'A';
    if (s >= 700) return 'B';
    if (s >= 550) return 'C';
    if (s >= 400) return 'D';
    return 'F';
  };

  const displayRating = rating || calculateRating(score);

  const sizeClasses = {
    sm: 'text-2xl',
    md: 'text-4xl',
    lg: 'text-6xl',
    xl: 'text-8xl',
  };

  const ratingSizeClasses = {
    sm: 'text-xl h-8 w-8',
    md: 'text-3xl h-12 w-12',
    lg: 'text-5xl h-20 w-20',
    xl: 'text-7xl h-28 w-28',
  };

  return (
    <div className={cn(
      "flex items-center gap-4 transition-transform duration-200",
      isAnimating && "scale-110"
    )}>
      {showRating && (
        <div className={cn(
          'flex items-center justify-center rounded-xl font-display font-bold transition-all duration-300',
          getRatingBg(displayRating),
          getRatingColor(displayRating),
          ratingSizeClasses[size],
          isAnimating && 'animate-pulse'
        )}>
          {displayRating}
        </div>
      )}
      <div className="text-center">
        <div className={cn(
          'font-display font-bold tabular-nums transition-all duration-200',
          sizeClasses[size],
          isAnimating && 'gradient-text'
        )}>
          {displayScore.toLocaleString()}
        </div>
        <div className={cn(
          "text-muted-foreground",
          size === 'xl' ? 'text-lg' : size === 'lg' ? 'text-base' : 'text-sm'
        )}>
          points
        </div>
      </div>
    </div>
  );
}
