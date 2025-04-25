import axios from 'axios';
import { htmlToText } from 'html-to-text';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { Document } from '@langchain/core/documents';
import pdfParse from 'pdf-parse';
import path from 'node:path';
import fs from 'node:fs';

// Function to save HTML content to debug folder
const saveHtmlToDebug = (html: string, url: string, prefix = 'reddit_html') => {
  try {
    // Check if DEBUG_SAVE_HTML environment variable is set
    if (process.env.DEBUG_SAVE_HTML !== 'true') {
      return null; // Skip saving if not in debug mode
    }
    
    const debugDir = path.join(process.cwd(), 'debug');
    
    // Create debug directory if it doesn't exist
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    
    // Create a safe filename from the URL
    const urlObj = new URL(url);
    const safeFilename = urlObj.pathname
      .replace(/[^a-z0-9]/gi, '_')
      .substring(0, 50); // Limit filename length
    
    // Format timestamp for the filename
    const timestamp = Date.now();
    const filename = `${prefix}_${safeFilename}_${timestamp}.html`;
    const filePath = path.join(debugDir, filename);
    
    // Write HTML to file
    fs.writeFileSync(filePath, html);
    console.log(`[INFO] Saved HTML content to: ${filePath}`);
    
    return filePath;
  } catch (error) {
    console.error('[ERROR] Failed to save HTML to debug folder:', error);
    return null;
  }
};

// Helper function to add delay between requests
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extract Reddit post content and comments from HTML
 * This function uses regex patterns to target the specific divs containing post content and comments
 */
export const extractRedditContent = (htmlContent: string): { 
  title: string;
  postContent: string;
  comments: { author: string; text: string; score?: string }[];
  success: boolean;
} => {
  try {
    // Extract the title
    const titleMatch = htmlContent.match(/<title>(.*?)<\/title>/);
    const title = titleMatch 
      ? titleMatch[1].replace(/ : .*$/, '') // Remove subreddit and "reddit" part
      : 'Reddit Discussion';
    
    // Initialize content storage
    let postContent = '';
    // Use a separate type for internal comment tracking that includes visibility
    let commentsList: { author: string; text: string; score?: string; scoreNum: number; visible: boolean }[] = [];
    
    // Extract the main post content - target the specific div with post content
    const postContentMatch = htmlContent.match(/<div class="usertext-body may-blank-within md-container[^"]*">\s*<div class="md">([\s\S]*?)<\/div>\s*<\/div>/);
    if (postContentMatch && postContentMatch[1]) {
      postContent = htmlToText(postContentMatch[1], { wordwrap: false });
    }
    
    // Extract comments using a more targeted approach that respects visibility
    
    // New pattern that captures the entire comment block with its class information
    // This lets us check if the comment has the 'noncollapsed' class that indicates it's visible
    const fullCommentRegex = /<div class="[^"]*thing[^"]*id-t1_[^"]*\s*([^"]*)"[\s\S]*?<\/div>\s*<div class="child">/g;
    
    // Pattern to extract author and comment text from each comment block
    const commentContentRegex = /<p class="tagline">[\s\S]*?<a href="[^"]*" class="author[^>]*>([^<]*)<[\s\S]*?<div class="md">([\s\S]*?)<\/div>/;
    
    // Pattern to extract comment score
    const scoreRegex = /<span class="score[^>]*>([\d]+) points?<\/span>/;
    
    // Maximum number of comments to extract to avoid context length issues
    const MAX_COMMENTS = 10;
    
    // Collect all comments first
    let allComments: { author: string; text: string; score?: string; scoreNum: number; visible: boolean }[] = [];
    let hiddenCommentCount = 0;
    let visibleCommentCount = 0;
    
    let commentMatch;
    while ((commentMatch = fullCommentRegex.exec(htmlContent)) !== null) {
      const commentHtml = commentMatch[0];
      // Check class information to determine if comment is visible
      const commentClasses = commentMatch[1] || '';
      // A comment is visible if it has the 'noncollapsed' class and doesn't have 'collapsed' class
      const isVisible = commentClasses.includes('noncollapsed') && !commentClasses.includes('collapsed');
      
      const contentMatch = commentHtml.match(commentContentRegex);
      
      if (contentMatch) {
        const author = contentMatch[1];
        const text = htmlToText(contentMatch[2], { wordwrap: false });
        
        // Try to extract score
        const scoreMatch = commentHtml.match(scoreRegex);
        const score = scoreMatch ? scoreMatch[1] : undefined;
        // Convert score to number for sorting, default to 0 if not found
        const scoreNum = score ? parseInt(score, 10) : 0;
        
        // Only include non-empty comments
        if (text.trim().length > 0) {
          allComments.push({ 
            author, 
            text: text.trim(), 
            score, 
            scoreNum,
            visible: isVisible 
          });
          
          // Track counts for logging
          if (isVisible) {
            visibleCommentCount++;
          } else {
            hiddenCommentCount++;
          }
        }
      }
    }
    
    // Sort all comments by score (highest first)
    allComments.sort((a, b) => b.scoreNum - a.scoreNum);
    
    // Filter to only include visible comments by default
    const visibleComments = allComments.filter(comment => comment.visible);
    
    // Take only the top MAX_COMMENTS from visible comments
    const outputComments = visibleComments.slice(0, MAX_COMMENTS).map(({ author, text, score }) => ({
      author,
      text,
      score
    }));
    
    console.log(`[INFO] Extracted ${allComments.length} total comments (${visibleCommentCount} visible, ${hiddenCommentCount} hidden)`);
    console.log(`[INFO] Selected top ${outputComments.length} visible comments by upvotes`);
    
    // If we didn't find enough visible comments, include some collapsed ones as a fallback
    let comments = outputComments;
    if (outputComments.length === 0 && allComments.length > 0) {
      console.log(`[WARN] No visible comments found, falling back to including collapsed comments`);
      comments = allComments.slice(0, MAX_COMMENTS).map(({ author, text, score }) => ({
        author,
        text,
        score
      }));
    }
    
    return {
      title,
      postContent,
      comments,
      success: postContent.length > 0 || comments.length > 0
    };
  } catch (error) {
    console.error('[ERROR] Error extracting Reddit content:', error);
    return {
      title: 'Reddit Discussion',
      postContent: '',
      comments: [],
      success: false
    };
  }
};

export const getDocumentsFromLinks = async ({ links }: { links: string[] }) => {
  const splitter = new RecursiveCharacterTextSplitter();

  let docs: Document[] = [];

  // Normalize Reddit URLs to reduce 404 errors
  const normalizedLinks = links.map(link => {
    let url = link.startsWith('http://') || link.startsWith('https://') 
      ? link 
      : `https://${link}`;
    
    // Remove tracking parameters and other Reddit-specific URL components
    if (url.includes('reddit.com')) {
      // Remove tracking parameters
      url = url.split('?')[0];
      
      // Handle non-standard Reddit URLs
      if (url.includes('klp/') || url.includes('/t/') || !url.includes('/comments/')) {
        return null; // Skip non-post URLs that might cause 404s
      }
      
      // Convert to old.reddit.com for easier parsing
      if (url.includes('www.reddit.com')) {
        url = url.replace('www.reddit.com', 'old.reddit.com');
      } else if (url.includes('reddit.com') && !url.includes('old.reddit.com')) {
        // Also handle reddit.com (without www)
        url = url.replace('reddit.com', 'old.reddit.com');
      }
    }
    
    return url;
  }).filter(Boolean) as string[]; // Remove null URLs

  // Filter for only Reddit URLs
  const redditLinks = normalizedLinks.filter(link => link.includes('reddit.com'));
  
  // IMPORTANT: Limit the number of Reddit links to process to avoid hanging
  const MAX_REDDIT_LINKS = 5; // Only process up to 5 Reddit URLs
  const redditLinksToProcess = redditLinks.slice(0, MAX_REDDIT_LINKS);
  
  console.log(`[INFO] Limiting Reddit link fetching to ${redditLinksToProcess.length} of ${redditLinks.length} URLs to prevent timeouts`);

  // Process Reddit links in smaller batches to avoid rate limiting
  const BATCH_SIZE = 2; // Process only 2 URLs at a time
  const BATCH_DELAY = 5000;
  
  // Process URLs in batches
  for (let i = 0; i < redditLinksToProcess.length; i += BATCH_SIZE) {
    const batchLinks = redditLinksToProcess.slice(i, i + BATCH_SIZE);
    console.log(`[INFO] Processing Reddit document batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(redditLinksToProcess.length/BATCH_SIZE)}: ${batchLinks.length} URLs`);
    
    // Process each batch concurrently
    await Promise.all(
      batchLinks.map(async (link) => {
        try {
          // Set up a timeout to prevent hanging on a single URL
          const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`Timed out fetching content from ${link}`));
            }, 20000); // 20 second timeout per URL
          });
          
          const fetchPromise = (async () => {
            console.log(`[INFO] Fetching Reddit content from: ${link}`);
          
            // Variable to store the response
            let res: any;
          
            // Determine if we're running in production (Vercel)
            const isProduction = process.env.VERCEL === '1';
          
            // Use our proxy API for Reddit URLs when in production
            let useDirectFetch = !isProduction;
            if (isProduction && link.includes('reddit.com')) {
              console.log(`[INFO] Using proxy API for Reddit URL in production environment`);
              
              // Use our internal API proxy when running on Vercel
              // Fix URL construction by ensuring we have a complete URL with https:// prefix
              let baseUrl;
              
              // Check if we're running on the client or server side
              if (typeof window !== 'undefined') {
                // Client-side: Use the current origin
                baseUrl = window.location.origin;
                console.log(`[INFO] Using client-side origin for API URL: ${baseUrl}`);
              } else {
                // Server-side: Use environment variables or fallback
                if (process.env.NEXT_PUBLIC_SITE_URL) {
                  baseUrl = process.env.NEXT_PUBLIC_SITE_URL;
                } else if (process.env.VERCEL_URL) {
                  baseUrl = `https://${process.env.VERCEL_URL}`;
                } else {
                  baseUrl = 'http://localhost:3000';
                }
                console.log(`[INFO] Using server-side base URL for API: ${baseUrl}`);
              }
              
              // Build the API URL
              const apiUrl = new URL('/api/reddit', baseUrl);
              apiUrl.searchParams.set('url', link);
              
              console.log(`[INFO] Fetching from proxy API: ${apiUrl.toString()}`);
              
              try {
                const proxyResponse = await fetch(apiUrl.toString(), {
                  headers: {
                    'Accept': 'text/html',
                  },
                  // Add a shorter timeout for the fetch itself
                  signal: AbortSignal.timeout(15000)
                });
                
                if (!proxyResponse.ok) {
                  const statusCode = proxyResponse.status;
                  console.error(`[ERROR] Proxy API returned ${statusCode}: ${proxyResponse.statusText}`);
                  
                  // If 401 Unauthorized or 404 Not Found, it likely means the proxy API isn't deployed properly
                  if (statusCode === 401 || statusCode === 404) {
                    console.warn('[WARN] Proxy API returned error status. Might be unavailable.');
                    throw new Error(`Proxy API returned ${statusCode}: ${proxyResponse.statusText}`);
                  }
                  
                  throw new Error(`Proxy API returned ${statusCode}: ${proxyResponse.statusText}`);
                }
                
                const htmlContent = await proxyResponse.text();
                
                if (!htmlContent || htmlContent.length < 1000) {
                  console.warn(`[WARN] Proxy API returned too little content: ${htmlContent.length} bytes`);
                  throw new Error('Insufficient content received from proxy');
                }
                
                res = { data: htmlContent };
                console.log(`[INFO] Successfully fetched HTML content from proxy: ${htmlContent.length} bytes`);
              } catch (error) {
                // Log the proxy error
                console.warn(`[WARN] Proxy API fetch failed: ${error instanceof Error ? error.message : String(error)}`);
                throw error; // Let the outer catch handle it
              }
            } else {
              // Use direct fetching method for non-production or non-Reddit URLs
              console.warn(`[WARN] Direct fetching disabled. Skipping URL.`);
              throw new Error('Direct fetching not implemented for simplicity');
            }
            
            // Special handling for Reddit content
            if (link.includes('reddit.com')) {
              const htmlContent = res.data.toString('utf8');
              
              // Save the complete HTML to debug folder for further analysis (only if DEBUG_SAVE_HTML=true)
              const htmlPath = saveHtmlToDebug(htmlContent, link, 'reddit_full_extraction');
              if (htmlPath) {
                console.log(`[INFO] Saved complete HTML for full extraction from ${link} to ${htmlPath}`);
              }
              
              console.log(`[INFO] Successfully retrieved HTML content for ${link} (${htmlContent.length} bytes)`);
              
              // Use the dedicated Reddit content extractor
              const extractedReddit = extractRedditContent(htmlContent);
              
              if (extractedReddit.success) {
                console.log(`[INFO] Successfully extracted Reddit content: ${extractedReddit.title}`);
                console.log(`[INFO] Post content length: ${extractedReddit.postContent.length} chars`);
                console.log(`[INFO] Extracted ${extractedReddit.comments.length} comments`);
                
                // Format the content with clear structure
                let formattedContent = `# ${extractedReddit.title}\n\n`;
                
                // Add post content if available
                if (extractedReddit.postContent.trim().length > 0) {
                  formattedContent += `## Original Post\n\n${extractedReddit.postContent.trim()}\n\n`;
                }
                
                // Add comments if available
                if (extractedReddit.comments.length > 0) {
                  formattedContent += `## Comments\n\n`;
                  extractedReddit.comments.forEach(comment => {
                    // Include score if available
                    const scoreText = comment.score ? ` (${comment.score} points)` : '';
                    formattedContent += `**${comment.author}${scoreText}**:\n${comment.text}\n\n`;
                  });
                }
                
                // Create the document with the formatted content
                const document = new Document({
                  pageContent: formattedContent.trim(),
                  metadata: {
                    title: extractedReddit.title,
                    url: link,
                    commentCount: extractedReddit.comments.length,
                    isReddit: true
                  },
                });
                
                console.log(`[INFO] Created Reddit document with ${formattedContent.length} characters`);
                docs.push(document);
                return;
              }
            }
          })();
          
          // Race between the fetch operation and the timeout
          await Promise.race([fetchPromise, timeoutPromise]);
          
        } catch (error) {
          console.error(
            `[ERROR] An error occurred while getting documents from link ${link}: `,
            error,
          );
          docs.push(
            new Document({
              pageContent: `Failed to retrieve content from the link: ${error instanceof Error ? error.message : String(error)}`,
              metadata: {
                title: 'Failed to retrieve content',
                url: link,
              },
            }),
          );
        }
      }),
    );
    
    // Wait before processing next batch (except for the last batch)
    if (i + BATCH_SIZE < redditLinksToProcess.length) {
      console.log(`[INFO] Waiting ${BATCH_DELAY}ms before processing next batch of Reddit documents...`);
      await delay(BATCH_DELAY);
    }
  }

  // Process non-Reddit URLs (just create placeholder documents for now to avoid more complexity)
  const nonRedditLinks = normalizedLinks.filter(link => !link.includes('reddit.com'));
  if (nonRedditLinks.length > 0) {
    console.log(`[INFO] Creating placeholder documents for ${nonRedditLinks.length} non-Reddit URLs`);
    for (const link of nonRedditLinks) {
      docs.push(
        new Document({
          pageContent: `This is a non-Reddit URL that was not processed to avoid complexity in this fix: ${link}`,
          metadata: {
            title: 'Non-Reddit URL',
            url: link,
          },
        }),
      );
    }
  }

  return docs;
};
