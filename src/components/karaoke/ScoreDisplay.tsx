import { cn } from '@/lib/utils';

interface ScoreDisplayProps {
  score: number;
  rating?: string;
  size?: 'sm' | 'md' | 'lg';
  showRating?: boolean;
}

export function ScoreDisplay({ score, rating, size = 'md', showRating = true }: ScoreDisplayProps) {
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
      case 'S': return 'bg-score-s/20';
      case 'A': return 'bg-score-a/20';
      case 'B': return 'bg-score-b/20';
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
  };

  const ratingSizeClasses = {
    sm: 'text-xl h-8 w-8',
    md: 'text-3xl h-12 w-12',
    lg: 'text-5xl h-20 w-20',
  };

  return (
    <div className="flex items-center gap-4">
      {showRating && (
        <div className={cn(
          'flex items-center justify-center rounded-xl font-display font-bold',
          getRatingBg(displayRating),
          getRatingColor(displayRating),
          ratingSizeClasses[size]
        )}>
          {displayRating}
        </div>
      )}
      <div>
        <div className={cn('font-display font-bold', sizeClasses[size])}>
          {score}
        </div>
        <div className="text-muted-foreground text-sm">points</div>
      </div>
    </div>
  );
}
