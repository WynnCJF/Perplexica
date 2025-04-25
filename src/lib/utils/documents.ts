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
      }
    }
    
    return url;
  }).filter(Boolean) as string[]; // Remove null URLs

  // Filter for only Reddit URLs
  const redditLinks = normalizedLinks.filter(link => link.includes('reddit.com'));

  // Process Reddit links in smaller batches to avoid rate limiting
  const BATCH_SIZE = 2; // Process only 2 URLs at a time
  const BATCH_DELAY = 5000; // Wait 5 seconds between batches
  
  // Process URLs in batches
  for (let i = 0; i < redditLinks.length; i += BATCH_SIZE) {
    const batchLinks = redditLinks.slice(i, i + BATCH_SIZE);
    console.log(`[INFO] Processing Reddit document batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(redditLinks.length/BATCH_SIZE)}: ${batchLinks.length} URLs`);
    
    // Process each batch concurrently
    await Promise.all(
      batchLinks.map(async (link) => {
        try {
          console.log(`[INFO] Fetching Reddit content from: ${link}`);
          
          // Add retry logic for Reddit fetches
          let res;
          let retries = 0;
          const maxRetries = 3;
          
          while (retries < maxRetries) {
            try {
              // Add delay between retries to avoid rate limiting
              if (retries > 0) {
                const delayTime = 2000 * retries; // Exponential backoff
                console.log(`[INFO] Retry ${retries}/${maxRetries} for ${link}, waiting ${delayTime}ms before retry...`);
                await delay(delayTime);
              }
              
              // First try with old.reddit.com
              let urlToFetch = link;
              if (link.includes('www.reddit.com')) {
                urlToFetch = link.replace('www.reddit.com', 'old.reddit.com');
                console.log(`[INFO] Trying to fetch from old.reddit.com: ${urlToFetch}`);
              }
              
              try {
                res = await axios.get(urlToFetch, {
                  responseType: 'arraybuffer',
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'max-age=0',
                    'Connection': 'keep-alive',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Ch-Ua': '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"macOS"',
                    'Cookie': '' // Just empty cookie to simulate a fresh session
                  },
                  timeout: 10000, // 10 second timeout
                  decompress: true, // Handle gzip compression
                  maxRedirects: 5
                });
              } catch (firstError) {
                // If old.reddit.com fails, try with www.reddit.com or reddit.com
                console.log(`[WARN] Failed with old.reddit.com, trying with www.reddit.com`);
                if (urlToFetch.includes('old.reddit.com')) {
                  const alternateUrl = urlToFetch.replace('old.reddit.com', 'www.reddit.com');
                  res = await axios.get(alternateUrl, {
                    responseType: 'arraybuffer',
                    headers: {
                      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                      'Accept-Language': 'en-US,en;q=0.9',
                      'Accept-Encoding': 'gzip, deflate, br',
                      'Cache-Control': 'no-cache',
                      'Pragma': 'no-cache',
                      'Connection': 'keep-alive',
                      'Sec-Fetch-Dest': 'document',
                      'Sec-Fetch-Mode': 'navigate',
                      'Sec-Fetch-Site': 'none',
                      'Sec-Fetch-User': '?1',
                      'Upgrade-Insecure-Requests': '1',
                      'Sec-Ch-Ua': '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
                      'Sec-Ch-Ua-Mobile': '?0',
                      'Sec-Ch-Ua-Platform': '"macOS"',
                      'Referer': 'https://www.google.com/' // Add referer to look more like a real browser
                    },
                    timeout: 10000,
                    decompress: true,
                    maxRedirects: 5
                  });
                } else {
                  throw firstError;
                }
              }
              
              // If successful, break the retry loop
              break;
            } catch (error: any) {
              retries++;
              const status = error.response?.status;
              
              if (status === 429) {
                // Rate limiting error - we need to wait longer
                console.log(`[WARN] Rate limited (429) when fetching ${link}. Retry ${retries}/${maxRetries}`);
                if (retries >= maxRetries) {
                  throw new Error(`Rate limited by Reddit after ${maxRetries} retries`);
                }
              } else {
                // Other error - might be worth retrying
                console.error(`[ERROR] Failed to fetch ${link}: ${error.message || error}`);
                if (retries >= maxRetries) {
                  throw error;
                }
              }
            }
          }
          
          // If we've reached here without a response, there was an issue
          if (!res) {
            throw new Error(`Failed to get response for ${link} after ${maxRetries} attempts`);
          }

          const isPdf = res.headers['content-type'] === 'application/pdf';

          if (isPdf) {
            const pdfText = await pdfParse(res.data);
            const parsedText = pdfText.text
              .replace(/(\r\n|\n|\r)/gm, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            const splittedText = await splitter.splitText(parsedText);
            const title = 'PDF Document';

            const linkDocs = splittedText.map((text) => {
              return new Document({
                pageContent: text,
                metadata: {
                  title: title,
                  url: link,
                },
              });
            });

            docs.push(...linkDocs);
            return;
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
            
            console.log('[DEBUG] Targeted extraction failed, falling back to general extraction');
            
            // Original fallback approach with improved selectors
            let extractedText = htmlToText(htmlContent, {
              selectors: [
                { selector: 'div.md', format: 'block' },
                { selector: 'div.thing', format: 'block' },
                { selector: 'div.usertext-body', format: 'block' }
              ],
              wordwrap: false
            });
            
            // If the above fails to get meaningful content, try without selectors
            if (extractedText.length < 500) {
              console.log('[DEBUG] First attempt returned too little content, trying without selectors');
              extractedText = htmlToText(htmlContent, { wordwrap: false });
            }
            
            // Remove common Reddit UI elements and metadata with more comprehensive patterns
            const cleanedText = extractedText
              .replace(/jump to content|my subreddits|edit subscriptions|popular|all|random|users/gi, '')
              .replace(/permalink|embed|save|report|give award|reply|share|crosspost/gi, '')
              .replace(/about|blog|advertising|careers|help|site rules|Reddit help center|reddiquette/gi, '')
              .replace(/mod guidelines|contact us|apps & tools|Reddit for iPhone|Reddit for Android/gi, '')
              .replace(/use of this site constitutes acceptance of our user agreement and privacy policy/gi, '')
              .replace(/© \d+ reddit inc\. all rights reserved/gi, '')
              .replace(/REDDIT and the ALIEN Logo are registered trademarks of reddit inc\./gi, '')
              .replace(/Rendered by PID \d+ on[\s\S]*?\+00:00 running[^.]+\./g, '')
              .replace(/get reddit premium|reddit premium/gi, '')
              .replace(/level \d+|award|points?|votes?|archived|this is an archived post/gi, '')
              .replace(/\[\+\]|\[\-\]|points?|\d+ (children|child)|expand|collapse|continue this thread/gi, '')
              .replace(/submitted \d+ (years?|months?|days?|hours?|minutes?|seconds?) ago( by [^ ]+)?/gi, '')
              .replace(/[\d,]+ comments|[\d,]+ points|[\d]% upvoted/gi, '')
              .replace(/join|leave|sort by: best|top|new|controversial|old|q&a/gi, '')
              .replace(/\bBEST\b|\bNEW\b|\bTOP\b|\bHOT\b|\bCONTROVERSIAL\b|\bRISING\b/gi, '')
              .replace(/\s{2,}/g, ' ')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            
            // Skip extraction if we didn't get meaningful content
            if (cleanedText.length < 200 || cleanedText.includes('Page not found')) {
              console.log('[DEBUG] Skipping document creation - insufficient content extracted');
              // Don't create a document for this URL
              return;
            }
            
            // Extract the title more reliably for the fallback method
            const title = extractedReddit.title || 'Reddit Discussion';
            
            // Create a single document with the content
            const document = new Document({
              pageContent: cleanedText,
              metadata: {
                title: title,
                url: link,
                isReddit: true
              },
            });
            
            console.log(`[DEBUG] Created document for ${link} with ${cleanedText.length} characters`);
            docs.push(document);
            return;
          }

          // Default handling for non-Reddit, non-PDF content
          const parsedText = htmlToText(res.data.toString('utf8'), {
            selectors: [
              {
                selector: 'a',
                format: 'inline',
                options: {
                  ignoreHref: true,
                },
              },
            ],
          })
            .replace(/(\r\n|\n|\r)/gm, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          const splittedText = await splitter.splitText(parsedText);
          const title = res.data
            .toString('utf8')
            .match(/<title>(.*?)<\/title>/)?.[1];

          const linkDocs = splittedText.map((text) => {
            return new Document({
              pageContent: text,
              metadata: {
                title: title || link,
                url: link,
              },
            });
          });

          docs.push(...linkDocs);
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
    if (i + BATCH_SIZE < redditLinks.length) {
      console.log(`[INFO] Waiting ${BATCH_DELAY}ms before processing next batch of Reddit documents...`);
      await delay(BATCH_DELAY);
    }
  }

  return docs;
};
