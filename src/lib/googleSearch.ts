import axios from 'axios';
import { getGooglePseApiKey, getGooglePseEngineId } from './config';

interface GoogleSearchOptions {
  language?: string;
  engines?: string[];
  pageno?: number;
  numResults?: number;
}

interface GoogleSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
}

export const searchGoogle = async (
  query: string,
  opts?: GoogleSearchOptions,
) => {
  // Get API key and Engine ID from config
  const apiKey = getGooglePseApiKey();
  const searchEngineId = getGooglePseEngineId();
  
  if (!apiKey || !searchEngineId) {
    throw new Error('Google PSE API key or Search Engine ID not configured');
  }

  // Prepend a "Reddit" to the query
  query = `Reddit ${query}`;

  // Construct the URL for Google Custom Search API
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.append('key', apiKey);
  url.searchParams.append('cx', searchEngineId);
  url.searchParams.append('q', query);

  console.log('Query to Google:', query);
  
  // Add pagination if specified
  if (opts?.pageno && opts.pageno > 1) {
    const start = (opts.pageno - 1) * 10 + 1;
    url.searchParams.append('start', start.toString());
  }
  
  // Add language parameter if specified
  if (opts?.language) {
    url.searchParams.append('lr', `lang_${opts.language}`);
  }
  
  // Add number of results parameter (default: 10, max: 10 per request)
  const numResults = opts?.numResults ?? 10;
  url.searchParams.append('num', Math.min(numResults, 10).toString());
  
  // Log the constructed URL (without API key) for debugging
  console.log(`Search URL (without API key): ${url.toString().replace(apiKey, 'API_KEY_HIDDEN')}`);

  try {
    const response = await axios.get(url.toString());
    
    // Map Google API response to the format expected by our application
    const results: GoogleSearchResult[] = response.data.items?.map((item: any) => ({
      title: item.title,
      url: item.link,
      content: item.snippet,
      img_src: item.pagemap?.cse_image?.[0]?.src,
      thumbnail_src: item.pagemap?.cse_thumbnail?.[0]?.src,
    })) || [];
    
    // Extract suggestions if available
    const suggestions: string[] = response.data.spelling?.correctedQuery 
      ? [response.data.spelling.correctedQuery]
      : [];

    // If more than 10 results are requested, we need to make multiple API calls
    // Note: This is subject to API quotas and rate limiting
    if (numResults > 10 && results.length === 10 && response.data.queries?.nextPage) {
      let allResults = [...results];
      let currentPage = 2;
      const maxPages = Math.ceil(numResults / 10);
      
      // Make additional API calls to get more results
      while (currentPage <= maxPages && allResults.length < numResults) {
        // Clone the URL and update the start parameter for pagination
        const nextPageUrl = new URL(url.toString());
        nextPageUrl.searchParams.set('start', ((currentPage - 1) * 10 + 1).toString());
        
        console.log(`Fetching additional results page ${currentPage}/${maxPages}`);
        
        try {
          const nextPageResponse = await axios.get(nextPageUrl.toString());
          
          if (nextPageResponse.data.items) {
            const nextPageResults = nextPageResponse.data.items.map((item: any) => ({
              title: item.title,
              url: item.link,
              content: item.snippet,
              img_src: item.pagemap?.cse_image?.[0]?.src,
              thumbnail_src: item.pagemap?.cse_thumbnail?.[0]?.src,
            }));
            
            allResults = [...allResults, ...nextPageResults];
          } else {
            // No more results available
            break;
          }
        } catch (error) {
          console.error(`Error fetching additional results page ${currentPage}:`, error);
          break;
        }
        
        currentPage++;
      }
      
      // Trim to the requested number of results
      return { 
        results: allResults.slice(0, numResults), 
        suggestions 
      };
    }

    return { results, suggestions };
  } catch (error) {
    console.error('Error searching with Google PSE:', error);
    // Return empty results on error to prevent breaking the application
    return { results: [], suggestions: [] };
  }
}; 