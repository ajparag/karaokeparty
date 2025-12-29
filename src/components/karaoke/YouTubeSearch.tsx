import { useState } from 'react';
import { Search, Music, Play } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

interface YouTubeVideo {
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
}

interface YouTubeSearchProps {
  onSelectVideo: (video: YouTubeVideo) => void;
}

// Simple YouTube video ID extractor and search using YouTube's internal API
export function YouTubeSearch({ onSelectVideo }: YouTubeSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YouTubeVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const searchVideos = async () => {
    if (!query.trim()) return;

    setLoading(true);
    
    try {
      // Check if it's a YouTube URL
      const urlMatch = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
      
      if (urlMatch) {
        // Extract video ID from URL
        const videoId = urlMatch[1];
        const video: YouTubeVideo = {
          id: videoId,
          title: 'YouTube Video',
          thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          channel: 'YouTube',
        };
        setResults([video]);
      } else {
        // For demo purposes, show popular karaoke videos
        // In production, you'd use YouTube Data API with an API key
        const demoResults: YouTubeVideo[] = [
          {
            id: 'dQw4w9WgXcQ',
            title: `${query} - Karaoke Version`,
            thumbnail: `https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg`,
            channel: 'Karaoke Channel',
          },
          {
            id: 'fJ9rUzIMcZQ',
            title: `${query} - Instrumental`,
            thumbnail: `https://img.youtube.com/vi/fJ9rUzIMcZQ/mqdefault.jpg`,
            channel: 'Karaoke Hits',
          },
          {
            id: 'kJQP7kiw5Fk',
            title: `${query} - Sing Along`,
            thumbnail: `https://img.youtube.com/vi/kJQP7kiw5Fk/mqdefault.jpg`,
            channel: 'Karaoke World',
          },
        ];
        setResults(demoResults);
        
        toast({
          title: 'Tip',
          description: 'Paste a YouTube URL directly for specific videos, or search for karaoke versions.',
        });
      }
    } catch (error) {
      toast({
        title: 'Search Error',
        description: 'Failed to search videos. Try pasting a YouTube URL directly.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      searchVideos();
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search for a song or paste YouTube URL..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            className="pl-10"
          />
        </div>
        <Button onClick={searchVideos} disabled={loading} className="gradient-primary">
          {loading ? 'Searching...' : 'Search'}
        </Button>
      </div>

      {results.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {results.map((video) => (
            <Card 
              key={video.id} 
              className="group cursor-pointer overflow-hidden hover:shadow-glow transition-all duration-300"
              onClick={() => onSelectVideo(video)}
            >
              <div className="relative aspect-video">
                <img
                  src={video.thumbnail}
                  alt={video.title}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-foreground/0 group-hover:bg-foreground/40 transition-colors flex items-center justify-center">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="h-14 w-14 rounded-full gradient-primary flex items-center justify-center shadow-glow">
                      <Play className="h-6 w-6 text-primary-foreground ml-1" />
                    </div>
                  </div>
                </div>
              </div>
              <CardContent className="p-4">
                <h3 className="font-medium line-clamp-2 group-hover:text-primary transition-colors">
                  {video.title}
                </h3>
                <p className="text-sm text-muted-foreground mt-1">{video.channel}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {results.length === 0 && (
        <div className="text-center py-12">
          <Music className="h-16 w-16 text-muted-foreground/30 mx-auto mb-4" />
          <h3 className="font-display text-xl font-semibold mb-2">Find Your Song</h3>
          <p className="text-muted-foreground">
            Search for karaoke or instrumental versions, or paste a YouTube URL
          </p>
        </div>
      )}
    </div>
  );
}
