-- Add optional name and city columns to scores table for public leaderboard display
ALTER TABLE public.scores ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.scores ADD COLUMN IF NOT EXISTS city text;

-- Update RLS policy to allow public reading of scores for leaderboard (anyone can view, not just authenticated)
DROP POLICY IF EXISTS "Authenticated users can view scores" ON public.scores;
CREATE POLICY "Anyone can view scores" ON public.scores FOR SELECT USING (true);