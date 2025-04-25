import fs from 'fs';
import path from 'path';
import toml from '@iarna/toml';

const configFileName = 'config.toml';

interface Config {
  GENERAL: {
    SIMILARITY_MEASURE: string;
    KEEP_ALIVE: string;
  };
  MODELS: {
    OPENAI: {
      API_KEY: string;
    };
    GROQ: {
      API_KEY: string;
    };
    ANTHROPIC: {
      API_KEY: string;
    };
    GEMINI: {
      API_KEY: string;
    };
    OLLAMA: {
      API_URL: string;
    };
    CUSTOM_OPENAI: {
      API_URL: string;
      API_KEY: string;
      MODEL_NAME: string;
    };
  };
  API_ENDPOINTS: {
    SEARXNG: string;
    GOOGLE_PSE: {
      API_KEY: string;
      ENGINE_ID: string;
    };
  };
}

type RecursivePartial<T> = {
  [P in keyof T]?: RecursivePartial<T[P]>;
};

// Enhanced loadConfig function that handles missing file gracefully
const loadConfig = (): Partial<Config> => {
  try {
    const configPath = path.join(process.cwd(), configFileName);
    if (fs.existsSync(configPath)) {
      return toml.parse(
        fs.readFileSync(configPath, 'utf-8')
      ) as any as Config;
    }
    // If running in production/deployment and no config file exists
    console.log('Config file not found, using environment variables only');
    return {} as Partial<Config>;
  } catch (error) {
    console.error('Error loading config file:', error);
    return {} as Partial<Config>;
  }
};

// Safe accessor function for nested config properties
const getConfigValue = <T>(accessor: (config: Config) => T, defaultValue: T): T => {
  try {
    const config = loadConfig();
    return accessor(config as Config) || defaultValue;
  } catch (error) {
    return defaultValue;
  }
};

export const getSimilarityMeasure = () => 
  process.env.SIMILARITY_MEASURE || 
  getConfigValue(config => config.GENERAL.SIMILARITY_MEASURE, 'cosine');

export const getKeepAlive = () => 
  process.env.KEEP_ALIVE || 
  getConfigValue(config => config.GENERAL.KEEP_ALIVE, '5m');

export const getOpenaiApiKey = () => 
  process.env.OPENAI_API_KEY || 
  getConfigValue(config => config.MODELS.OPENAI.API_KEY, '');

export const getGroqApiKey = () => 
  process.env.GROQ_API_KEY || 
  getConfigValue(config => config.MODELS.GROQ.API_KEY, '');

export const getAnthropicApiKey = () => 
  process.env.ANTHROPIC_API_KEY || 
  getConfigValue(config => config.MODELS.ANTHROPIC.API_KEY, '');

export const getGeminiApiKey = () => 
  process.env.GEMINI_API_KEY || 
  getConfigValue(config => config.MODELS.GEMINI.API_KEY, '');

export const getSearxngApiEndpoint = () =>
  process.env.SEARXNG_API_URL || 
  getConfigValue(config => config.API_ENDPOINTS.SEARXNG, '');

export const getOllamaApiEndpoint = () => 
  process.env.OLLAMA_API_URL || 
  getConfigValue(config => config.MODELS.OLLAMA.API_URL, '');

export const getCustomOpenaiApiKey = () =>
  process.env.CUSTOM_OPENAI_API_KEY || 
  getConfigValue(config => config.MODELS.CUSTOM_OPENAI.API_KEY, '');

export const getCustomOpenaiApiUrl = () =>
  process.env.CUSTOM_OPENAI_API_URL || 
  getConfigValue(config => config.MODELS.CUSTOM_OPENAI.API_URL, '');

export const getCustomOpenaiModelName = () =>
  process.env.CUSTOM_OPENAI_MODEL_NAME || 
  getConfigValue(config => config.MODELS.CUSTOM_OPENAI.MODEL_NAME, '');

export const getGooglePseApiKey = () => 
  process.env.GOOGLE_PSE_API_KEY || 
  getConfigValue(config => config.API_ENDPOINTS.GOOGLE_PSE.API_KEY, '');

export const getGooglePseEngineId = () =>
  process.env.GOOGLE_PSE_ID || 
  getConfigValue(config => config.API_ENDPOINTS.GOOGLE_PSE.ENGINE_ID, '');

// Verify critical configuration is available
export const verifyRequiredConfig = () => {
  // Check Google PSE configuration
  const googlePseKey = getGooglePseApiKey();
  const googlePseId = getGooglePseEngineId();
  
  if (!googlePseKey || !googlePseId) {
    console.warn('WARNING: Missing Google PSE configuration. Search functionality may not work correctly.');
  }
  
  // Check other critical configurations as needed
  // Add more checks here as required for your application
};

const mergeConfigs = (current: any, update: any): any => {
  if (update === null || update === undefined) {
    return current;
  }

  if (typeof current !== 'object' || current === null) {
    return update;
  }

  const result = { ...current };

  for (const key in update) {
    if (Object.prototype.hasOwnProperty.call(update, key)) {
      const updateValue = update[key];

      if (
        typeof updateValue === 'object' &&
        updateValue !== null &&
        typeof result[key] === 'object' &&
        result[key] !== null
      ) {
        result[key] = mergeConfigs(result[key], updateValue);
      } else if (updateValue !== undefined) {
        result[key] = updateValue;
      }
    }
  }

  return result;
};

export const updateConfig = (config: RecursivePartial<Config>) => {
  try {
    const configPath = path.join(process.cwd(), configFileName);
    let currentConfig = {} as Config;
    
    // Load existing config if it exists
    if (fs.existsSync(configPath)) {
      currentConfig = loadConfig() as Config;
    }
    
    const mergedConfig = mergeConfigs(currentConfig, config);
    fs.writeFileSync(configPath, toml.stringify(mergedConfig));
    return true;
  } catch (error) {
    console.error('Error updating config file:', error);
    return false;
  }
};
