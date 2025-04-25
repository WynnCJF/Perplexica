import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  PromptTemplate,
} from '@langchain/core/prompts';
import {
  RunnableLambda,
  RunnableMap,
  RunnableSequence,
} from '@langchain/core/runnables';
import { BaseMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import LineListOutputParser from '../outputParsers/listLineOutputParser';
import LineOutputParser from '../outputParsers/lineOutputParser';
import { getDocumentsFromLinks } from '../utils/documents';
import { Document } from 'langchain/document';
import { searchGoogle } from '../googleSearch';
import path from 'node:path';
import fs from 'node:fs';
import computeSimilarity from '../utils/computeSimilarity';
import formatChatHistoryAsString from '../utils/formatHistory';
import eventEmitter from 'events';
import { StreamEvent } from '@langchain/core/tracers/log_stream';
import axios from 'axios';

// Function to log Reddit ranking data to a file
const logRedditRanking = (data: any, prefix = 'reddit_ranking') => {
  try {
    const logDir = path.join(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Format timestamp for the filename
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const logFile = path.join(logDir, `${prefix}_${timestamp}.json`);
    
    // Write log to file
    fs.writeFileSync(logFile, JSON.stringify(data, null, 2));
    console.log(`[INFO] Reddit ranking data logged to: ${logFile}`);
    
    return logFile;
  } catch (error) {
    console.error('[ERROR] Failed to log Reddit ranking data:', error);
    return null;
  }
};

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

export interface MetaSearchAgentType {
  searchAndAnswer: (
    message: string,
    history: BaseMessage[],
    llm: BaseChatModel,
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
    fileIds: string[],
  ) => Promise<eventEmitter>;
}

interface Config {
  searchWeb: boolean;
  rerank: boolean;
  summarizer: boolean;
  rerankThreshold: number;
  queryGeneratorPrompt: string;
  responsePrompt: string;
  activeEngines: string[];
}

type BasicChainInput = {
  chat_history: BaseMessage[];
  query: string;
};

// Add a utility function to log the entire prompt to a file
const logCompletePrompt = (prompt: any, query: string) => {
  try {
    const logDir = path.join(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Format timestamp for the filename
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const sanitizedQuery = query.replace(/[^\w\s]/g, '_').substring(0, 30);
    const logFile = path.join(logDir, `prompt_${sanitizedQuery}_${timestamp}.log`);
    
    // For messages format, convert to readable format
    let logContent = '';
    
    if (Array.isArray(prompt)) {
      // Handle array of messages format
      logContent = prompt.map((msg, i) => {
        return `\n=== MESSAGE ${i+1} (${msg._getType()}) ===\n${msg.content}\n`;
      }).join('\n');
    } else if (typeof prompt === 'string') {
      // Handle string format
      logContent = prompt;
    } else {
      // Handle other formats by stringifying
      logContent = JSON.stringify(prompt, null, 2);
    }
    
    // Write log to file
    fs.writeFileSync(logFile, `COMPLETE LLM PROMPT FOR QUERY: "${query}"\n\n${logContent}`);
    console.log(`[DEBUG] Complete prompt logged to: ${logFile}`);
  } catch (error) {
    console.error('[DEBUG] Error logging complete prompt:', error);
  }
};

class MetaSearchAgent implements MetaSearchAgentType {
  private config: Config;
  private strParser = new StringOutputParser();

  constructor(config: Config) {
    this.config = config;
  }

  private async createSearchRetrieverChain(llm: BaseChatModel) {
    (llm as unknown as ChatOpenAI).temperature = 0;

    return RunnableSequence.from([
      PromptTemplate.fromTemplate(this.config.queryGeneratorPrompt),
      llm,
      this.strParser,
      RunnableLambda.from(async (input: string) => {
        const linksOutputParser = new LineListOutputParser({  // parse link the input
          key: 'links',
        });

        const questionOutputParser = new LineOutputParser({  // parse question from the input
          key: 'question',
        });

        const links = await linksOutputParser.parse(input);
        let question = this.config.summarizer
          ? await questionOutputParser.parse(input)
          : input;

        if (question === 'not_needed') {
          return { query: '', docs: [] };
        }

        if (links.length > 0) {
          if (question.length === 0) {
            question = 'summarize';
          }

          let docs: Document[] = [];

          const linkDocs = await getDocumentsFromLinks({ links });

          const docGroups: Document[] = [];

          linkDocs.map((doc) => {
            const URLDocExists = docGroups.find(
              (d) =>
                d.metadata.url === doc.metadata.url &&
                d.metadata.totalDocs < 10,
            );

            if (!URLDocExists) {
              docGroups.push({
                ...doc,
                metadata: {
                  ...doc.metadata,
                  totalDocs: 1,
                },
              });
            }

            const docIndex = docGroups.findIndex(
              (d) =>
                d.metadata.url === doc.metadata.url &&
                d.metadata.totalDocs < 10,
            );

            if (docIndex !== -1) {
              docGroups[docIndex].pageContent =
                docGroups[docIndex].pageContent + `\n\n` + doc.pageContent;
              docGroups[docIndex].metadata.totalDocs += 1;
            }
          });

          await Promise.all(
            docGroups.map(async (doc) => {
              const res = await llm.invoke(`
            You are a web search summarizer, tasked with summarizing a piece of text retrieved from a web search. Your job is to summarize the 
            text into a detailed, 2-4 paragraph explanation that captures the main ideas and provides a comprehensive answer to the query.
            If the query is \"summarize\", you should provide a detailed summary of the text. If the query is a specific question, you should answer it in the summary.
            
            - **Journalistic tone**: The summary should sound professional and journalistic, not too casual or vague.
            - **Thorough and detailed**: Ensure that every key point from the text is captured and that the summary directly answers the query.
            - **Not too lengthy, but detailed**: The summary should be informative but not excessively long. Focus on providing detailed information in a concise format.

            The text will be shared inside the \`text\` XML tag, and the query inside the \`query\` XML tag.

            <example>
            1. \`<text>
            Docker is a set of platform-as-a-service products that use OS-level virtualization to deliver software in packages called containers. 
            It was first released in 2013 and is developed by Docker, Inc. Docker is designed to make it easier to create, deploy, and run applications 
            by using containers.
            </text>

            <query>
            What is Docker and how does it work?
            </query>

            Response:
            Docker is a revolutionary platform-as-a-service product developed by Docker, Inc., that uses container technology to make application 
            deployment more efficient. It allows developers to package their software with all necessary dependencies, making it easier to run in 
            any environment. Released in 2013, Docker has transformed the way applications are built, deployed, and managed.
            \`
            2. \`<text>
            The theory of relativity, or simply relativity, encompasses two interrelated theories of Albert Einstein: special relativity and general
            relativity. However, the word "relativity" is sometimes used in reference to Galilean invariance. The term "theory of relativity" was based
            on the expression "relative theory" used by Max Planck in 1906. The theory of relativity usually encompasses two interrelated theories by
            Albert Einstein: special relativity and general relativity. Special relativity applies to all physical phenomena in the absence of gravity.
            General relativity explains the law of gravitation and its relation to other forces of nature. It applies to the cosmological and astrophysical
            realm, including astronomy.
            </text>

            <query>
            summarize
            </query>

            Response:
            The theory of relativity, developed by Albert Einstein, encompasses two main theories: special relativity and general relativity. Special
            relativity applies to all physical phenomena in the absence of gravity, while general relativity explains the law of gravitation and its
            relation to other forces of nature. The theory of relativity is based on the concept of "relative theory," as introduced by Max Planck in
            1906. It is a fundamental theory in physics that has revolutionized our understanding of the universe.
            \`
            </example>

            Everything below is the actual data you will be working with. Good luck!

            <query>
            ${question}
            </query>

            <text>
            ${doc.pageContent}
            </text>

            Make sure to answer the query in the summary.
          `);

              const document = new Document({
                pageContent: res.content as string,
                metadata: {
                  title: doc.metadata.title,
                  url: doc.metadata.url,
                },
              });

              docs.push(document);
            }),
          );

          return { query: question, docs: docs };
        } else {
          question = question.replace(/<think>.*?<\/think>/g, '');

          console.log('Question:', question);
          const res = await searchGoogle(question, {
            language: 'en',
            engines: this.config.activeEngines,
            numResults: 20,
          });

          console.log('Search results:', res);

          // Filter to include only Reddit URLs
          const redditResults = res.results.filter(result => 
            result.url.includes('reddit.com')
          );
          
          // Log the filtered Reddit results to a file instead of console
          const redditResultsLogFile = logRedditRanking(redditResults, 'reddit_results');
          console.log(`[INFO] Reddit search results saved to: ${redditResultsLogFile}`);

          // Take up to 20 Reddit URLs for initial analysis (increased from 10)
          const initialRedditUrls = redditResults.slice(0, 20).map(result => result.url);
          let documents: Document[] = [];
          
          // Start collecting ranking data for logging
          const rankingLog = {
            query: question,
            timestamp: new Date().toISOString(),
            initialUrlsCount: initialRedditUrls.length,
            initialUrls: initialRedditUrls,
            analysisResults: [] as any[],
            selectedUrls: [] as string[],
            documents: [] as any[]
          };
          
          if (initialRedditUrls.length > 0) {
            console.log(`[INFO] Analyzing ${initialRedditUrls.length} Reddit URLs for ranking`);
            
            // Define a function to extract just the top comment score from a Reddit URL
            const extractTopCommentScore = async (url: string): Promise<{url: string, score: number, details: string, metrics: any}> => {
              try {
                // Normalize URL for Reddit
                let normalizedUrl = url;
                if (normalizedUrl.includes('www.reddit.com')) {
                  normalizedUrl = normalizedUrl.replace('www.reddit.com', 'old.reddit.com');
                }
                
                // Fetch the HTML content with retry logic and rate limiting
                console.log(`[INFO] Fetching data from ${url}`);
                let response;
                let retries = 0;
                const maxRetries = 3;
                
                while (retries < maxRetries) {
                  try {
                    // Add delay between requests to avoid rate limiting
                    if (retries > 0) {
                      const delayTime = 2000 * retries; // Exponential backoff
                      console.log(`[INFO] Retry ${retries}/${maxRetries}, waiting ${delayTime}ms before retry...`);
                      await delay(delayTime);
                    }
                    
                    // First try with old.reddit.com
                    let urlToFetch = normalizedUrl;
                    
                    try {
                      response = await axios.get(urlToFetch, {
                        responseType: 'text',
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
                        timeout: 5000, // Shorter timeout for initial analysis
                        decompress: true, // Handle gzip compression
                        maxRedirects: 5
                      });
                    } catch (firstError) {
                      // If old.reddit.com fails, try with www.reddit.com
                      console.log(`[WARN] Failed with first URL, trying alternative domain`);
                      if (urlToFetch.includes('old.reddit.com')) {
                        const alternateUrl = urlToFetch.replace('old.reddit.com', 'www.reddit.com');
                        response = await axios.get(alternateUrl, {
                          responseType: 'text',
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
                          timeout: 5000,
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
                      console.log(`[WARN] Rate limited (429) when fetching ${url}. Retry ${retries}/${maxRetries}`);
                      if (retries >= maxRetries) {
                        throw new Error(`Rate limited by Reddit after ${maxRetries} retries`);
                      }
                    } else {
                      // Other error - might be worth retrying
                      console.error(`[ERROR] Failed to fetch ${url}: ${error.message}`);
                      if (retries >= maxRetries) {
                        throw error;
                      }
                    }
                  }
                }
                
                // If we've reached here without a response, there was an issue
                if (!response) {
                  throw new Error(`Failed to get response for ${url} after ${maxRetries} attempts`);
                }
                
                const html = response.data;
                
                // Save the complete HTML to debug folder (only if DEBUG_SAVE_HTML=true)
                const htmlPath = saveHtmlToDebug(html, url);
                if (htmlPath) {
                  console.log(`[INFO] Saved complete HTML for ${url} to ${htmlPath}`);
                }
                
                // Extract comment score using regex
                // Pattern to find comment blocks in the HTML
                const commentRegex = /<div class=" thing id-t1_[^"]*[\s\S]*?<\/div>\s*<div class="child">/g;
                
                // Pattern to extract score from each comment block
                const scoreRegex = /<span class="score[^>]*>([\d]+) points?<\/span>/;
                
                let highestScore = 0;
                let commentMatch;
                let matchCount = 0;
                let commentScores: number[] = [];
                
                // Find all comments and extract their scores
                while ((commentMatch = commentRegex.exec(html)) !== null) {
                  matchCount++;
                  const commentHtml = commentMatch[0];
                  const scoreMatch = commentHtml.match(scoreRegex);
                  
                  if (scoreMatch && scoreMatch[1]) {
                    const score = parseInt(scoreMatch[1], 10);
                    commentScores.push(score);
                    if (score > highestScore) {
                      highestScore = score;
                    }
                  }
                }
                
                // Also try to extract the post score
                const postScoreMatch = html.match(/<div class="score[^"]*"[^>]*>([\d,]+)<\/div>/);
                let postScore = 0;
                
                if (postScoreMatch && postScoreMatch[1]) {
                  postScore = parseInt(postScoreMatch[1].replace(/,/g, ''), 10);
                } else {
                  // Try alternative pattern for post score
                  const altScoreMatch = html.match(/<div class="score unvoted"[^>]*>([\d,]+)<\/div>/);
                  if (altScoreMatch && altScoreMatch[1]) {
                    postScore = parseInt(altScoreMatch[1].replace(/,/g, ''), 10);
                  }
                }
                
                // Use a combined scoring approach (post score + top comment score)
                const combinedScore = highestScore + (postScore > 0 ? Math.log10(postScore) * 3 : 0);
                
                // Extract post title for better logging
                const titleMatch = html.match(/<title>(.*?)<\/title>/);
                const title = titleMatch ? titleMatch[1].replace(/ : .*$/, '') : 'Unknown';
                
                // Create detailed diagnostics string
                const details = `Title: "${title.substring(0, 50)}...", PostScore: ${postScore}, TopCommentScore: ${highestScore}, Comments: ${matchCount}`;
                
                // Create metrics object for structured logging
                const metrics = {
                  url,
                  normalizedUrl,
                  title,
                  postScore,
                  highestCommentScore: highestScore,
                  commentCount: matchCount,
                  commentScores: commentScores.sort((a, b) => b - a).slice(0, 10), // Save top 10 comment scores
                  combinedScore,
                  htmlLength: html.length
                };
                
                console.log(`[INFO] Analyzed ${url}: Score ${combinedScore.toFixed(2)}`);
                
                return {
                  url,
                  score: combinedScore,
                  details,
                  metrics
                };
              } catch (error) {
                console.error(`[ERROR] Failed to analyze ${url}:`, error);
                return {
                  url,
                  score: 0,
                  details: `Error: ${error instanceof Error ? error.message : String(error)}`,
                  metrics: { url, error: error instanceof Error ? error.message : String(error) }
                };
              }
            };
            
            // Analyze all URLs in parallel with rate limiting
            console.log(`[INFO] Starting analysis of URLs with rate limiting...`);
            
            // Process URLs in batches
            const BATCH_SIZE = 3; // Process 3 URLs at a time
            const BATCH_DELAY = 3000; // Wait 3 seconds between batches
            
            let allScoreResults: Array<{url: string, score: number, details: string, metrics: any}> = [];
            
            // Process URLs in batches
            for (let i = 0; i < initialRedditUrls.length; i += BATCH_SIZE) {
              const batchUrls = initialRedditUrls.slice(i, i + BATCH_SIZE);
              console.log(`[INFO] Processing batch ${i/BATCH_SIZE + 1}/${Math.ceil(initialRedditUrls.length/BATCH_SIZE)}: ${batchUrls.length} URLs`);
              
              // Process batch in parallel
              const batchResults = await Promise.all(
                batchUrls.map(url => extractTopCommentScore(url)
                  .catch(error => {
                    console.error(`[ERROR] Failed to analyze ${url}: ${error}`);
                    // Return a dummy result with zero score on error
                    return {
                      url,
                      score: 0,
                      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
                      metrics: { url, error: error instanceof Error ? error.message : String(error) }
                    };
                  })
                )
              );
              
              // Add batch results to overall results
              allScoreResults = [...allScoreResults, ...batchResults];
              
              // Wait before processing next batch (except for the last batch)
              if (i + BATCH_SIZE < initialRedditUrls.length) {
                console.log(`[INFO] Waiting ${BATCH_DELAY}ms before processing next batch...`);
                await delay(BATCH_DELAY);
              }
            }
            
            // Add results to ranking log
            rankingLog.analysisResults = allScoreResults.map(r => r.metrics);
            
            // Sort by score (highest first)
            const sortedResults = allScoreResults.sort((a, b) => b.score - a.score);
            
            // Take top 10 (increased from 5)
            const topRedditUrls = sortedResults
              .slice(0, 10)
              .map(result => result.url);
            
            // Add selected URLs to ranking log
            rankingLog.selectedUrls = topRedditUrls;
            
            console.log(`[INFO] Selected top ${topRedditUrls.length} Reddit URLs by comment scores`);
            
            // Now fetch full content from the top URLs
            if (topRedditUrls.length > 0) {
              console.log(`[INFO] Fetching full content from top ${topRedditUrls.length} URLs...`);
              // Use the existing function to fetch full content from filtered Reddit URLs
              documents = await getDocumentsFromLinks({ links: topRedditUrls });
              
              // Add document summaries to ranking log
              rankingLog.documents = documents.map(doc => ({
                title: doc.metadata.title,
                url: doc.metadata.url,
                contentLength: doc.pageContent.length,
                commentCount: doc.metadata.commentCount || 0,
                isReddit: doc.metadata.isReddit || false
              }));
              
              console.log(`[INFO] Fetched ${documents.length} documents from top Reddit URLs`);
              
              // Save the complete ranking log to a file
              logRedditRanking(rankingLog, 'reddit_ranking_complete');
              
              // Check if we have any successful document fetches
              const successfulDocuments = documents.filter(doc => 
                doc.pageContent && doc.pageContent.length > 100
              );
              
              // If no documents were fetched successfully or too few, fall back to search snippets
              if (successfulDocuments.length < 2) {
                console.log('[INFO] Too few documents fetched from Reddit URLs, falling back to snippets');
                
                // Add any successfully fetched documents first
                const snippetDocuments = redditResults.map(
                  (result) =>
                    new Document({
                      pageContent:
                        result.content ||
                        (this.config.activeEngines.includes('youtube')
                          ? result.title
                          : ''),
                      metadata: {
                        title: result.title,
                        url: result.url,
                        ...(result.img_src && { img_src: result.img_src }),
                        isSnippet: true
                      },
                    }),
                );
                
                // Merge the documents (successful fetches + search snippets)
                documents = [...successfulDocuments, ...snippetDocuments];
                console.log(`[INFO] Combined ${successfulDocuments.length} fetched documents with ${snippetDocuments.length} snippet documents`);
              }
            } else {
              // No Reddit results, use original search results
              documents = res.results.map(
                (result) =>
                  new Document({
                    pageContent:
                      result.content ||
                      (this.config.activeEngines.includes('youtube')
                        ? result.title
                        : ''),
                    metadata: {
                      title: result.title,
                      url: result.url,
                      ...(result.img_src && { img_src: result.img_src }),
                    },
                  }),
              );
            }
          }

          return { query: question, docs: documents };
        }
      }),
    ]);
  }

  private async createAnsweringChain(
    llm: BaseChatModel,
    fileIds: string[],
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
  ) {
    return RunnableSequence.from([
      RunnableMap.from({
        query: (input: BasicChainInput) => input.query,
        chat_history: (input: BasicChainInput) => input.chat_history,
        date: () => new Date().toISOString(),
        context: RunnableLambda.from(async (input: BasicChainInput) => {
          const processedHistory = formatChatHistoryAsString(
            input.chat_history,
          );

          let docs: Document[] | null = null;
          let query = input.query;

          if (this.config.searchWeb) {
            const searchRetrieverChain =
              await this.createSearchRetrieverChain(llm);

            const searchRetrieverResult = await searchRetrieverChain.invoke({
              chat_history: processedHistory,
              query,
            });

            query = searchRetrieverResult.query;
            docs = searchRetrieverResult.docs;
          }

          const sortedDocs = await this.rerankDocs(
            query,
            docs ?? [],
            fileIds,
            embeddings,
            optimizationMode,
          );

          return sortedDocs;
        })
          .withConfig({
            runName: 'FinalSourceRetriever',
          })
          .pipe(this.processDocs),
      }),
      RunnableLambda.from(async (input) => {
        const promptTemplate = ChatPromptTemplate.fromMessages([
          ['system', this.config.responsePrompt],
          new MessagesPlaceholder('chat_history'),
          ['user', '{query}'],
        ]);
        
        const formattedPrompt = await promptTemplate.formatMessages({
          context: input.context,
          date: input.date,
          chat_history: input.chat_history,
          query: input.query
        });
        
        // Log the complete formatted prompt to a file
        logCompletePrompt(formattedPrompt, input.query);

        return input;
      }),
      ChatPromptTemplate.fromMessages([
        ['system', this.config.responsePrompt],
        new MessagesPlaceholder('chat_history'),
        ['user', '{query}'],
      ]),
      llm,
      this.strParser,
    ]).withConfig({
      runName: 'FinalResponseGenerator',
    });
  }

  private async rerankDocs(
    query: string,
    docs: Document[],
    fileIds: string[],
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
  ) {
    if (docs.length === 0 && fileIds.length === 0) {
      return docs;
    }

    const filesData = fileIds
      .map((file) => {
        const filePath = path.join(process.cwd(), 'uploads', file);

        const contentPath = filePath + '-extracted.json';
        const embeddingsPath = filePath + '-embeddings.json';

        const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
        const embeddings = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));

        const fileSimilaritySearchObject = content.contents.map(
          (c: string, i: number) => {
            return {
              fileName: content.title,
              content: c,
              embeddings: embeddings.embeddings[i],
            };
          },
        );

        return fileSimilaritySearchObject;
      })
      .flat();

    if (query.toLocaleLowerCase() === 'summarize') {
      return docs.slice(0, 30);  // this may need to be changed
    }

    const docsWithContent = docs.filter(
      (doc) => doc.pageContent && doc.pageContent.length > 0,
    );

    if (optimizationMode === 'speed' || this.config.rerank === false) {
      if (filesData.length > 0) {
        const [queryEmbedding] = await Promise.all([
          embeddings.embedQuery(query),
        ]);

        const fileDocs = filesData.map((fileData) => {
          return new Document({
            pageContent: fileData.content,
            metadata: {
              title: fileData.fileName,
              url: `File`,
            },
          });
        });

        const similarity = filesData.map((fileData, i) => {
          const sim = computeSimilarity(queryEmbedding, fileData.embeddings);

          return {
            index: i,
            similarity: sim,
          };
        });

        let sortedDocs = similarity
          .filter(
            (sim) => sim.similarity > (this.config.rerankThreshold ?? 0.3),
          )
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 30)
          .map((sim) => fileDocs[sim.index]);

        sortedDocs =
          docsWithContent.length > 0 ? sortedDocs.slice(0, 30) : sortedDocs;

        return [
          ...sortedDocs,
          ...docsWithContent.slice(0, 30 - sortedDocs.length),  // when there are files, only the files are ranked, and web documents are directly added to the end
        ];
      } else {
        return docsWithContent.slice(0, 30);  // no re-ranking at all if there are no files uploaded
      }
    } else if (optimizationMode === 'balanced') {
      const [docEmbeddings, queryEmbedding] = await Promise.all([
        embeddings.embedDocuments(
          docsWithContent.map((doc) => doc.pageContent),
        ),
        embeddings.embedQuery(query),
      ]);

      docsWithContent.push(
        ...filesData.map((fileData) => {
          return new Document({
            pageContent: fileData.content,
            metadata: {
              title: fileData.fileName,
              url: `File`,
            },
          });
        }),
      );

      docEmbeddings.push(...filesData.map((fileData) => fileData.embeddings));

      const similarity = docEmbeddings.map((docEmbedding, i) => {
        const sim = computeSimilarity(queryEmbedding, docEmbedding);

        return {
          index: i,
          similarity: sim,
        };
      });

      const sortedDocs = similarity
        .filter((sim) => sim.similarity > (this.config.rerankThreshold ?? 0.3))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 20)
        .map((sim) => docsWithContent[sim.index]);

      return sortedDocs;
    }

    return [];
  }

  private processDocs(docs: Document[]) {
    // Limit the number of documents to avoid context length issues
    const MAX_DOCUMENTS = 8;
    if (docs.length > MAX_DOCUMENTS) {
      console.log(`[DEBUG] Limiting number of documents from ${docs.length} to ${MAX_DOCUMENTS} to avoid token limit issues`);
      docs = docs.slice(0, MAX_DOCUMENTS);
    }
    
    // Add a header to emphasize the importance of using multiple sources
    const header = `
IMPORTANT: This search query has returned ${docs.length} sources. You should use information from most of these sources in your response, as long as they contain relevant information.
The sources are listed below, numbered from 1 to ${docs.length}. Use these numbers when citing information in your response.
`;

    // Process each document with more context and limit content length for each source
    const processedDocs = docs
      .map(
        (doc, index) => {
          const source = `${index + 1}. ${doc.metadata.title || 'Untitled'} (Source: ${doc.metadata.url || 'Unknown'})`;
          
          // Add special marker for Reddit sources to emphasize them
          const isRedditSource = doc.metadata.isReddit || (doc.metadata.url && doc.metadata.url.includes('reddit.com'));
          const sourceType = isRedditSource ? ' [REDDIT DISCUSSION]' : '';
          
          // For structured Reddit content (with comments), we can keep more content
          // Reddit content is already pre-formatted in a structured way
          const maxLength = isRedditSource ? 6000 : 2000;
          let content = doc.pageContent;
          
          if (content.length > maxLength) {
            // For Reddit content, try to preserve structure by keeping headers intact
            if (isRedditSource) {
              // Find the positions of main sections
              const postHeaderPos = content.indexOf('## Original Post');
              const commentsHeaderPos = content.indexOf('## Comments');
              
              if (postHeaderPos !== -1 && commentsHeaderPos !== -1) {
                // Keep the post content and some comments, prioritizing the post
                const postSection = content.substring(postHeaderPos, commentsHeaderPos);
                
                // Calculate how much space we have left for comments
                const remainingSpace = maxLength - postSection.length;
                let commentsSection = '';
                
                if (remainingSpace > 500) {
                  // Get the comments section and truncate it
                  commentsSection = content.substring(commentsHeaderPos);
                  if (commentsSection.length > remainingSpace) {
                    // Find the last complete comment before the cutoff
                    const cutoffPoint = commentsSection.lastIndexOf('\n\n', remainingSpace);
                    commentsSection = cutoffPoint !== -1 
                      ? commentsSection.substring(0, cutoffPoint) 
                      : commentsSection.substring(0, remainingSpace);
                    commentsSection += '\n\n[...additional comments truncated...]';
                  }
                } else {
                  commentsSection = '\n\n## Comments\n\n[Comments truncated to fit length limit]';
                }
                
                // Combine the title, post content, and truncated comments
                const titleSection = content.substring(0, postHeaderPos);
                content = titleSection + postSection + commentsSection;
              } else {
                // If we can't identify sections, use the standard approach
                const beginningPortion = content.substring(0, maxLength * 0.75);
                const endingPortion = content.substring(content.length - (maxLength * 0.25));
                content = beginningPortion + "\n\n[...content truncated...]\n\n" + endingPortion;
              }
            } else {
              // Standard approach for non-Reddit content
              const beginningPortion = content.substring(0, maxLength * 0.75);
              const endingPortion = content.substring(content.length - (maxLength * 0.25));
              content = beginningPortion + "\n\n[...content truncated...]\n\n" + endingPortion;
            }
            
            console.log(`[DEBUG] Truncated document ${index + 1} from ${doc.pageContent.length} to ${content.length} characters`);
          }
          
          return `${source}${sourceType}\n${content}\n`;
        }
      )
      .join('\n---\n\n');

    return header + processedDocs;
  }

  private async handleStream(
    stream: AsyncGenerator<StreamEvent, any, any>,
    emitter: eventEmitter,
  ) {
    for await (const event of stream) {
      if (
        event.event === 'on_chain_end' &&
        event.name === 'FinalSourceRetriever'
      ) {
        ``;
        emitter.emit(
          'data',
          JSON.stringify({ type: 'sources', data: event.data.output }),
        );
      }
      if (
        event.event === 'on_chain_stream' &&
        event.name === 'FinalResponseGenerator'
      ) {
        emitter.emit(
          'data',
          JSON.stringify({ type: 'response', data: event.data.chunk }),
        );
      }
      if (
        event.event === 'on_chain_end' &&
        event.name === 'FinalResponseGenerator'
      ) {
        emitter.emit('end');
      }
    }
  }

  async searchAndAnswer(
    message: string,
    history: BaseMessage[],
    llm: BaseChatModel,
    embeddings: Embeddings,
    optimizationMode: 'speed' | 'balanced' | 'quality',
    fileIds: string[],
  ) {
    const emitter = new eventEmitter();

    const answeringChain = await this.createAnsweringChain(
      llm,
      fileIds,
      embeddings,
      optimizationMode,
    );

    const stream = answeringChain.streamEvents(
      {
        chat_history: history,
        query: message,
      },
      {
        version: 'v1',
      },
    );

    this.handleStream(stream, emitter);

    return emitter;
  }
}

export default MetaSearchAgent;
