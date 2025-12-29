import { cn } from '@/lib/utils';

interface FloatingScoreProps {
  score: number;
  pitchAccuracy: number;
  rhythmAccuracy: number;
  className?: string;
}

export function FloatingScore({ score, pitchAccuracy, rhythmAccuracy, className }: FloatingScoreProps) {
  const getRating = (s: number) => {
    if (s >= 950) return 'S';
    if (s >= 850) return 'A';
    if (s >= 700) return 'B';
    if (s >= 550) return 'C';
    if (s >= 400) return 'D';
    return 'F';
  };

  const getRatingColor = (r: string) => {
    switch (r) {
      case 'S': return 'from-yellow-400 to-amber-500';
      case 'A': return 'from-green-400 to-emerald-500';
      case 'B': return 'from-blue-400 to-cyan-500';
      case 'C': return 'from-orange-400 to-amber-500';
      case 'D': return 'from-orange-500 to-red-500';
      case 'F': return 'from-red-400 to-red-600';
      default: return 'from-gray-400 to-gray-500';
    }
  };

  const rating = getRating(score);

  return (
    <div className={cn(
      "absolute top-4 right-4 z-20 flex items-center gap-3 px-4 py-3 rounded-2xl",
      "bg-background/80 backdrop-blur-md border border-border/50 shadow-lg",
      "transition-all duration-300",
      className
    )}>
      {/* Rating Badge */}
      <div className={cn(
        "w-12 h-12 rounded-xl flex items-center justify-center font-display font-bold text-xl",
        "bg-gradient-to-br text-white shadow-md",
        getRatingColor(rating)
      )}>
        {rating}
      </div>

      {/* Score & Metrics */}
      <div className="flex flex-col">
        <div className="font-display font-bold text-2xl tabular-nums leading-tight">
          {score.toLocaleString()}
        </div>
        <div className="flex gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-primary" />
            Pitch {Math.round(pitchAccuracy)}%
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-accent" />
            Rhythm {Math.round(rhythmAccuracy)}%
          </span>
        </div>
      </div>
    </div>
  );
}
