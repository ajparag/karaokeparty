-- Harden SECURITY DEFINER helper functions with additional validation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.id IS NULL OR NEW.email IS NULL OR length(trim(NEW.email)) = 0 THEN
    RAISE EXCEPTION 'Invalid user data';
  END IF;

  INSERT INTO public.profiles (user_id, username)
  VALUES (
    NEW.id,
    left(
      COALESCE(
        nullif(trim(NEW.raw_user_meta_data ->> 'username'), ''),
        SPLIT_PART(NEW.email, '@', 1)
      ),
      50
    )
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_profile_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'scores' OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Invalid trigger context';
  END IF;

  IF NEW.user_id IS NULL OR NEW.score IS NULL OR NEW.score < 0 OR NEW.score > 1000 THEN
    RAISE EXCEPTION 'Invalid score data';
  END IF;

  UPDATE public.profiles
  SET 
    total_score = COALESCE(total_score, 0) + NEW.score,
    songs_performed = COALESCE(songs_performed, 0) + 1,
    updated_at = now()
  WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$function$;

-- Server-side validation and cleanup for public leaderboard submissions
CREATE OR REPLACE FUNCTION public.validate_score_submission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'Missing score owner';
  END IF;

  IF NEW.score IS NULL OR NEW.score < 0 OR NEW.score > 1000 THEN
    RAISE EXCEPTION 'Score must be between 0 and 1000';
  END IF;

  IF NEW.rating IS NULL OR NEW.rating NOT IN ('L', 'S', 'A', 'B', 'C', 'D', 'F') THEN
    RAISE EXCEPTION 'Invalid score rating';
  END IF;

  IF NEW.song_title IS NULL OR length(trim(NEW.song_title)) = 0 OR length(NEW.song_title) > 200 THEN
    RAISE EXCEPTION 'Invalid song title';
  END IF;

  IF NEW.track_id IS NULL OR length(trim(NEW.track_id)) = 0 OR length(NEW.track_id) > 200 THEN
    RAISE EXCEPTION 'Invalid track id';
  END IF;

  NEW.display_name := nullif(left(regexp_replace(trim(COALESCE(NEW.display_name, '')), '[<>]', '', 'g'), 50), '');
  NEW.city := nullif(left(regexp_replace(trim(COALESCE(NEW.city, '')), '[<>]', '', 'g'), 50), '');
  NEW.song_title := left(trim(NEW.song_title), 200);
  NEW.song_artist := nullif(left(trim(COALESCE(NEW.song_artist, '')), 200), '');
  NEW.track_id := left(trim(NEW.track_id), 200);
  NEW.thumbnail_url := nullif(left(trim(COALESCE(NEW.thumbnail_url, '')), 1000), '');

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_score_submission_before_insert ON public.scores;
CREATE TRIGGER validate_score_submission_before_insert
BEFORE INSERT ON public.scores
FOR EACH ROW
EXECUTE FUNCTION public.validate_score_submission();

-- Add database-level validation for future writes, without rejecting existing historical rows during migration
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_score_range') THEN
    ALTER TABLE public.scores ADD CONSTRAINT scores_score_range CHECK (score >= 0 AND score <= 1000) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_rating_allowed') THEN
    ALTER TABLE public.scores ADD CONSTRAINT scores_rating_allowed CHECK (rating IN ('L', 'S', 'A', 'B', 'C', 'D', 'F')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_display_name_safe') THEN
    ALTER TABLE public.scores ADD CONSTRAINT scores_display_name_safe CHECK (display_name IS NULL OR (length(display_name) <= 50 AND position('<' in display_name) = 0 AND position('>' in display_name) = 0)) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scores_city_safe') THEN
    ALTER TABLE public.scores ADD CONSTRAINT scores_city_safe CHECK (city IS NULL OR (length(city) <= 50 AND position('<' in city) = 0 AND position('>' in city) = 0)) NOT VALID;
  END IF;
END $$;

-- Block direct browser inserts; score submissions should go through an authenticated backend function
DROP POLICY IF EXISTS "Users can insert their own scores" ON public.scores;

-- Prevent public API callers from manually executing helper functions
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_profile_stats() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_score_submission() FROM PUBLIC, anon, authenticated;