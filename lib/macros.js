const MACROS = {
  '@google_search': (query) => `https://www.google.com/search?q=${encodeURIComponent(query || '')}`,
  '@youtube_search': (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query || '')}`,
  '@amazon_search': (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query || '')}`,
  '@reddit_search': (query) => `https://www.reddit.com/search.json?q=${encodeURIComponent(query || '')}&limit=25`,
  '@reddit_subreddit': (query) => `https://www.reddit.com/r/${encodeURIComponent(query || 'all')}.json?limit=25`,
  '@wikipedia_search': (query) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query || '')}`,
  '@twitter_search': (query) => `https://twitter.com/search?q=${encodeURIComponent(query || '')}`,
  '@yelp_search': (query) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(query || '')}`,
  '@spotify_search': (query) => `https://open.spotify.com/search/${encodeURIComponent(query || '')}`,
  '@netflix_search': (query) => `https://www.netflix.com/search?q=${encodeURIComponent(query || '')}`,
  '@linkedin_search': (query) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query || '')}`,
  '@instagram_search': (query) => `https://www.instagram.com/explore/tags/${encodeURIComponent(query || '')}`,
  '@tiktok_search': (query) => `https://www.tiktok.com/search?q=${encodeURIComponent(query || '')}`,
  '@twitch_search': (query) => `https://www.twitch.tv/search?term=${encodeURIComponent(query || '')}`
};

function expandMacro(macro, query) {
  // Keep dispatch explicit: request data must never select an arbitrary object
  // property and invoke it as a function.
  switch (macro) {
    case '@google_search': return MACROS['@google_search'](query);
    case '@youtube_search': return MACROS['@youtube_search'](query);
    case '@amazon_search': return MACROS['@amazon_search'](query);
    case '@reddit_search': return MACROS['@reddit_search'](query);
    case '@reddit_subreddit': return MACROS['@reddit_subreddit'](query);
    case '@wikipedia_search': return MACROS['@wikipedia_search'](query);
    case '@twitter_search': return MACROS['@twitter_search'](query);
    case '@yelp_search': return MACROS['@yelp_search'](query);
    case '@spotify_search': return MACROS['@spotify_search'](query);
    case '@netflix_search': return MACROS['@netflix_search'](query);
    case '@linkedin_search': return MACROS['@linkedin_search'](query);
    case '@instagram_search': return MACROS['@instagram_search'](query);
    case '@tiktok_search': return MACROS['@tiktok_search'](query);
    case '@twitch_search': return MACROS['@twitch_search'](query);
    default: return null;
  }
}

function getSupportedMacros() {
  return Object.keys(MACROS);
}

export {
  expandMacro,
  getSupportedMacros,
  MACROS
};
