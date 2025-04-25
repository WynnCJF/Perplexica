import { NextRequest, NextResponse } from 'next/server';

// Define types for Reddit JSON API response
interface RedditComment {
  kind: string;
  data: {
    id: string;
    author: string;
    score: number;
    body: string;
    stickied: boolean;
  };
}

interface RedditPost {
  kind: string;
  data: {
    title: string;
    subreddit: string;
    score: number;
    selftext: string;
  };
}

// Reddit URLs will be fetched through reliable proxy services
export async function GET(request: NextRequest) {
  try {
    // Add an overall timeout for the entire function
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Request timed out after 30 seconds'));
      }, 30000);
    });
    
    // The actual request handling logic
    const requestHandlingPromise = (async () => {
      // Extract URL from query parameters
      const { searchParams } = new URL(request.url);
      const url = searchParams.get('url');
      
      // Validate URL
      if (!url) {
        return NextResponse.json(
          { error: 'Missing URL parameter' },
          { status: 400 }
        );
      }
      
      // Validate it's a Reddit URL
      if (!url.includes('reddit.com')) {
        return NextResponse.json(
          { error: 'Only Reddit URLs are supported' },
          { status: 400 }
        );
      }
      
      // Convert to old.reddit.com for more reliable parsing
      let normalizedUrl = url;
      if (normalizedUrl.includes('www.reddit.com')) {
        normalizedUrl = normalizedUrl.replace('www.reddit.com', 'old.reddit.com');
      } else if (normalizedUrl.includes('reddit.com') && !normalizedUrl.includes('old.reddit.com')) {
        // Also handle reddit.com (without www)
        normalizedUrl = normalizedUrl.replace('reddit.com', 'old.reddit.com');
      }
      
      console.log(`[INFO] Reddit proxy handling request for: ${normalizedUrl} (original: ${url})`);
      
      // Try allorigins.win first - most reliable
      try {
        const allOriginsUrl = new URL('https://api.allorigins.win/raw');
        allOriginsUrl.searchParams.set('url', normalizedUrl);
        
        console.log(`[INFO] Trying to fetch via allorigins proxy: ${allOriginsUrl.toString()}`);
        
        const response = await fetch(allOriginsUrl.toString(), {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Cache-Control': 'no-cache'
          },
          // Add a timeout to prevent hanging on the fetch
          signal: AbortSignal.timeout(15000)
        });
        
        if (response.ok) {
          const html = await response.text();
          // Verify that we got actual content, not a blank page or error page
          if (html.length > 5000 && !html.includes('access denied') && !html.includes('captcha')) {
            console.log(`[INFO] AllOrigins successful! Got ${html.length} bytes`);
            return new NextResponse(html, {
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
              }
            });
          }
          console.log(`[WARN] AllOrigins didn't return valid content (${html.length} bytes)`);
        } else {
          console.log(`[WARN] AllOrigins failed with status: ${response.status}`);
        }
      } catch (error) {
        console.log(`[WARN] AllOrigins approach failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Fall back to CORS Anywhere type proxy if available
      try {
        // Note: You should replace this with a proper CORS proxy URL
        const corsProxyUrl = `https://corsproxy.io/?${encodeURIComponent(normalizedUrl)}`;
        console.log(`[INFO] Trying CORS proxy: ${corsProxyUrl}`);
        
        const corsResponse = await fetch(corsProxyUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Cache-Control': 'no-cache'
          },
          cache: 'no-store',
          // Add a timeout to prevent hanging on the fetch
          signal: AbortSignal.timeout(15000)
        });
        
        if (corsResponse.ok) {
          const html = await corsResponse.text();
          if (html.length > 5000 && !html.includes('whoa there, pardner') && !html.includes('network policy')) {
            console.log(`[INFO] CORS proxy successful! Got ${html.length} bytes`);
            return new NextResponse(html, {
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
              }
            });
          }
          console.log(`[INFO] CORS proxy returned too little content or blocking page: ${html.length} bytes`);
        } else {
          console.log(`[INFO] CORS proxy approach failed: ${corsResponse.status} ${corsResponse.statusText}`);
        }
      } catch (corsError) {
        console.log(`[INFO] CORS proxy approach error: ${corsError}`);
      }
      
      // If we reached here, all approaches failed
      console.error(`[ERROR] All proxy methods failed for ${normalizedUrl}`);
      return NextResponse.json(
        { error: `All proxy methods failed for Reddit URL` },
        { status: 502 }
      );
    })();
    
    // Race the request handling against the timeout
    return Promise.race([requestHandlingPromise, timeoutPromise]) as Promise<NextResponse>;
  } catch (error) {
    console.error('[ERROR] Reddit proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch content from Reddit' },
      { status: 500 }
    );
  }
}

/**
 * Convert Reddit JSON API response to a simplified HTML format that matches
 * what our existing HTML parsers expect
 */
function convertRedditJsonToHtml(data: any[]): string {
  try {
    if (!data || !Array.isArray(data) || data.length < 2) {
      throw new Error('Invalid Reddit JSON data format');
    }
    
    // Extract post data and comments
    const postData = data[0]?.data?.children?.[0]?.data;
    const commentsData: RedditComment[] = data[1]?.data?.children || [];
    
    if (!postData) {
      throw new Error('Could not extract post data from Reddit JSON');
    }
    
    // Extract post title
    const title = postData.title || 'Reddit Discussion';
    const subreddit = postData.subreddit || '';
    const postScore = postData.score || 0;
    const postContent = postData.selftext || '';
    
    // Create HTML structure
    let html = `
<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)} : ${escapeHtml(subreddit)}</title>
</head>
<body>
  <div class="post-container">
    <h1>${escapeHtml(title)}</h1>
    <div class="score" data-score="${postScore}">${postScore}</div>
    <div class="usertext-body may-blank-within md-container">
      <div class="md">${escapeHtml(postContent)}</div>
    </div>
    
    <div class="comments-container">
`;
    
    // Add comments if available
    if (commentsData && commentsData.length > 0) {
      commentsData.forEach((comment: RedditComment) => {
        if (comment.kind === 't1') {
          const commentData = comment.data;
          if (commentData && !commentData.stickied) {
            const author = commentData.author || '[deleted]';
            const score = commentData.score || 0;
            const text = commentData.body || '';
            const cssClass = score > 1 ? 'noncollapsed' : '';
            
            html += `
      <div class="thing id-t1_${commentData.id} ${cssClass}">
        <p class="tagline">
          <a href="/user/${author}" class="author">${escapeHtml(author)}</a>
          <span class="score" score="${score}">${score} points</span>
        </p>
        <div class="md">${escapeHtml(text)}</div>
      </div>
      <div class="child"></div>
`;
          }
        }
      });
    }
    
    html += `
    </div>
  </div>
</body>
</html>
`;
    
    return html;
  } catch (error) {
    console.error('[ERROR] Error converting Reddit JSON to HTML:', error);
    return `
<!DOCTYPE html>
<html>
<head><title>Error Processing Reddit Content</title></head>
<body>
  <div class="error">Failed to process Reddit content: ${error instanceof Error ? error.message : String(error)}</div>
</body>
</html>
`;
  }
}

/**
 * Simple HTML escaping function to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
} 