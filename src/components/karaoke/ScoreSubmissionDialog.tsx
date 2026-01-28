import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Trophy, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ScoreSubmissionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (displayName: string, city: string) => Promise<void>;
  score: number;
  rating: { letter: string; color: string };
  songTitle: string;
  isSubmitting: boolean;
}

export function ScoreSubmissionDialog({
  isOpen,
  onClose,
  onSubmit,
  score,
  rating,
  songTitle,
  isSubmitting,
}: ScoreSubmissionDialogProps) {
  const [displayName, setDisplayName] = useState('');
  const [city, setCity] = useState('');

  const handleSubmit = async () => {
    await onSubmit(displayName.trim(), city.trim());
  };

  const handleClose = () => {
    setDisplayName('');
    setCity('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md bg-card">
        <DialogHeader className="text-center">
          <div className="mx-auto mb-4">
            <div className={cn(
              "inline-flex items-center justify-center w-20 h-20 rounded-full",
              "bg-gradient-to-br from-primary to-accent shadow-glow"
            )}>
              <Trophy className="w-10 h-10 text-primary-foreground" />
            </div>
          </div>
          <DialogTitle className="text-2xl">Your Final Score!</DialogTitle>
          <DialogDescription className="text-center">
            <span className="block text-4xl font-bold mt-2 mb-1">
              <span className={rating.color}>{rating.letter}</span>
              <span className="text-foreground ml-2">{score.toLocaleString()}</span>
            </span>
            <span className="text-muted-foreground">{songTitle}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground text-center">
            Add your details to appear on the leaderboard (optional)
          </p>
          
          <div className="space-y-2">
            <Label htmlFor="display-name">Your Name</Label>
            <Input
              id="display-name"
              placeholder="Enter your name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={50}
              disabled={isSubmitting}
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              placeholder="Enter your city (optional)"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              maxLength={50}
              disabled={isSubmitting}
            />
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            <X className="w-4 h-4 mr-2" />
            Close
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="w-full sm:w-auto gradient-primary text-primary-foreground"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Trophy className="w-4 h-4 mr-2" />
                Save to Leaderboard
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
