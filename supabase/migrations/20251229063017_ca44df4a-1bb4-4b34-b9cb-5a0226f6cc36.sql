-- Create profiles table for user data
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  username TEXT NOT NULL,
  avatar_url TEXT,
  total_score INTEGER DEFAULT 0,
  songs_performed INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Create scores table for performance history
CREATE TABLE public.scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  song_title TEXT NOT NULL,
  song_artist TEXT,
  youtube_video_id TEXT NOT NULL,
  thumbnail_url TEXT,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  rating TEXT NOT NULL CHECK (rating IN ('S', 'A', 'B', 'C', 'D', 'F')),
  rhythm_accuracy NUMERIC(5,2),
  timing_accuracy NUMERIC(5,2),
  duration_seconds INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scores ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Profiles are viewable by everyone" 
ON public.profiles FOR SELECT USING (true);

CREATE POLICY "Users can insert their own profile" 
ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile" 
ON public.profiles FOR UPDATE USING (auth.uid() = user_id);

-- Scores policies
CREATE POLICY "Scores are viewable by everyone" 
ON public.scores FOR SELECT USING (true);

CREATE POLICY "Users can insert their own scores" 
ON public.scores FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own scores" 
ON public.scores FOR DELETE USING (auth.uid() = user_id);

-- Enable realtime for leaderboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.scores;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;

-- Function to handle new user creation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, username)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'username', SPLIT_PART(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$;

-- Trigger to create profile on signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to update profile stats after new score
CREATE OR REPLACE FUNCTION public.update_profile_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles
  SET 
    total_score = total_score + NEW.score,
    songs_performed = songs_performed + 1,
    updated_at = now()
  WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

-- Trigger to update stats after score insert
CREATE TRIGGER on_score_created
  AFTER INSERT ON public.scores
  FOR EACH ROW EXECUTE FUNCTION public.update_profile_stats();

-- Create index for leaderboard queries
CREATE INDEX idx_scores_score ON public.scores(score DESC);
CREATE INDEX idx_scores_user_id ON public.scores(user_id);
CREATE INDEX idx_profiles_total_score ON public.profiles(total_score DESC);