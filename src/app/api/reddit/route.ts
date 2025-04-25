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
    const url = request.nextUrl.searchParams.get('url');
    
    if (!url) {
      return NextResponse.json(
        { error: 'Missing URL parameter' },
        { status: 400 }
      );
    }
    
    // Check if the URL is a Reddit URL
    if (!url.includes('reddit.com')) {
      return NextResponse.json(
        { error: 'Only Reddit URLs are allowed' },
        { status: 400 }
      );
    }
    
    // Always convert to old.reddit.com format for better parsing
    let normalizedUrl = url;
    if (normalizedUrl.includes('www.reddit.com')) {
      normalizedUrl = normalizedUrl.replace('www.reddit.com', 'old.reddit.com');
    } else if (normalizedUrl.includes('reddit.com') && !normalizedUrl.includes('old.reddit.com')) {
      normalizedUrl = normalizedUrl.replace('reddit.com', 'old.reddit.com');
    }
    
    console.log(`[INFO] Reddit proxy handling request for: ${normalizedUrl} (original: ${url})`);
    
    // First attempt: Try using allorigins proxy service
    const allOriginsUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(normalizedUrl)}`;
    console.log(`[INFO] Trying to fetch via allorigins proxy: ${allOriginsUrl}`);
    
    try {
      const allOriginsResponse = await fetch(allOriginsUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Cache-Control': 'no-cache'
        },
        cache: 'no-store'
      });
      
      if (allOriginsResponse.ok) {
        const html = await allOriginsResponse.text();
        if (html.length > 5000 && !html.includes('whoa there, pardner') && !html.includes('network policy')) { // Sanity check for valid response
          console.log(`[INFO] AllOrigins successful! Got ${html.length} bytes`);
          return new NextResponse(html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600'
            }
          });
        }
        console.log(`[INFO] AllOrigins returned too little content or blocking page: ${html.length} bytes`);
      } else {
        console.log(`[INFO] AllOrigins approach failed: ${allOriginsResponse.status} ${allOriginsResponse.statusText}`);
      }
    } catch (allOriginsError) {
      console.log(`[INFO] AllOrigins approach error: ${allOriginsError}`);
    }
    
    // Second attempt: Try using archive.is service
    const archiveUrl = `https://archive.is/latest/${normalizedUrl}`;
    console.log(`[INFO] Trying to fetch from archive.is: ${archiveUrl}`);
    
    try {
      const archiveResponse = await fetch(archiveUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
        cache: 'no-store'
      });
      
      if (archiveResponse.ok) {
        const html = await archiveResponse.text();
        if (html.length > 5000 && !html.includes('whoa there, pardner') && !html.includes('network policy')) { // Sanity check for valid response
          console.log(`[INFO] Archive.is successful! Got ${html.length} bytes`);
          return new NextResponse(html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600'
            }
          });
        }
        console.log(`[INFO] Archive.is returned too little content or blocking page: ${html.length} bytes`);
      } else {
        console.log(`[INFO] Archive.is approach failed: ${archiveResponse.status} ${archiveResponse.statusText}`);
      }
    } catch (archiveError) {
      console.log(`[INFO] Archive.is approach error: ${archiveError}`);
    }
    
    // Third attempt: Try direct fetch with old.reddit.com
    console.log(`[INFO] Trying direct fetch with old.reddit.com: ${normalizedUrl}`);
    
    try {
      const directResponse = await fetch(normalizedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
        redirect: 'follow',
        cache: 'no-store'
      });
      
      if (directResponse.ok) {
        const html = await directResponse.text();
        if (html.length > 5000 && !html.includes('whoa there, pardner') && !html.includes('network policy')) { // Sanity check for valid response
          console.log(`[INFO] Direct fetch successful! Got ${html.length} bytes`);
          return new NextResponse(html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=3600'
            }
          });
        }
        console.log(`[INFO] Direct fetch returned too little content or blocking page: ${html.length} bytes`);
      } else {
        console.log(`[INFO] Direct fetch failed: ${directResponse.status} ${directResponse.statusText}`);
      }
    } catch (directError) {
      console.log(`[INFO] Direct fetch error: ${directError}`);
    }
    
    // Fourth attempt: Try with a different proxy service - cors-anywhere style
    // Note: This is a fallback option that might not always work as these services often have rate limits
    const corsProxyUrl = `https://corsproxy.io/?${encodeURIComponent(normalizedUrl)}`;
    console.log(`[INFO] Trying to fetch via CORS proxy: ${corsProxyUrl}`);
    
    try {
      const corsResponse = await fetch(corsProxyUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Cache-Control': 'no-cache'
        },
        cache: 'no-store'
      });
      
      if (corsResponse.ok) {
        const html = await corsResponse.text();
        if (html.length > 5000 && !html.includes('whoa there, pardner') && !html.includes('network policy')) { // Sanity check for valid response
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
    
    console.error(`[ERROR] All proxy methods failed for ${normalizedUrl}`);
    return NextResponse.json(
      { error: `All proxy methods failed for Reddit URL` },
      { status: 502 }
    );
    
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