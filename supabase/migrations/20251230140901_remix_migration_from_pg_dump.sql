CREATE EXTENSION IF NOT EXISTS "pg_graphql";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "plpgsql";
CREATE EXTENSION IF NOT EXISTS "supabase_vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";
BEGIN;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (user_id, username)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'username', SPLIT_PART(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$;


--
-- Name: update_profile_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_profile_stats() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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


SET default_table_access_method = heap;

--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    username text NOT NULL,
    avatar_url text,
    total_score integer DEFAULT 0,
    songs_performed integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    song_title text NOT NULL,
    song_artist text,
    youtube_video_id text NOT NULL,
    thumbnail_url text,
    score integer NOT NULL,
    rating text NOT NULL,
    rhythm_accuracy numeric(5,2),
    timing_accuracy numeric(5,2),
    duration_seconds integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scores_rating_check CHECK ((rating = ANY (ARRAY['S'::text, 'A'::text, 'B'::text, 'C'::text, 'D'::text, 'F'::text]))),
    CONSTRAINT scores_score_check CHECK (((score >= 0) AND (score <= 1000)))
);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);


--
-- Name: scores scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_pkey PRIMARY KEY (id);


--
-- Name: idx_profiles_total_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_total_score ON public.profiles USING btree (total_score DESC);


--
-- Name: idx_scores_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scores_score ON public.scores USING btree (score DESC);


--
-- Name: idx_scores_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scores_user_id ON public.scores USING btree (user_id);


--
-- Name: scores on_score_created; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_score_created AFTER INSERT ON public.scores FOR EACH ROW EXECUTE FUNCTION public.update_profile_stats();


--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: scores scores_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles Profiles are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);


--
-- Name: scores Scores are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Scores are viewable by everyone" ON public.scores FOR SELECT USING (true);


--
-- Name: scores Users can delete their own scores; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own scores" ON public.scores FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: profiles Users can insert their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: scores Users can insert their own scores; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own scores" ON public.scores FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scores ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--




COMMIT;