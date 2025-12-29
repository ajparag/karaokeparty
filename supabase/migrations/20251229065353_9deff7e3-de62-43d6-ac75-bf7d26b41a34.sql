-- Update the score constraint to allow 0-1000
ALTER TABLE public.scores DROP CONSTRAINT IF EXISTS scores_score_check;
ALTER TABLE public.scores ADD CONSTRAINT scores_score_check CHECK (score >= 0 AND score <= 1000);