// ============================================================
// RSS Sources — 36 total (17 RU + 19 EN)
// Added: Finam RSS feeds (v7.8)
// ============================================================

export interface RssSource {
  id: string;
  name: string;
  url: string;
  lang: 'ru' | 'en';
  category: string;
}

export const RSS_SOURCES: RssSource[] = [
  // Russian (13)
  { id: 'lenta', name: 'Лента.ru', url: 'https://lenta.ru/rss/news', lang: 'ru', category: 'news' },
  { id: 'kommersant', name: 'Коммерсант', url: 'https://www.kommersant.ru/RSS/news.xml', lang: 'ru', category: 'business' },
  { id: 'rbc', name: 'РБК', url: 'https://rssexport.rbc.ru/rbcnews/news/30/default.rss', lang: 'ru', category: 'business' },
  { id: 'vedomosti', name: 'Ведомости', url: 'https://www.vedomosti.ru/rss/news', lang: 'ru', category: 'business' },
  { id: 'tass', name: 'ТАСС', url: 'https://tass.ru/rss/v2.xml', lang: 'ru', category: 'news' },
  { id: 'ria', name: 'РИА Новости', url: 'https://ria.ru/export/rss2/archive/index.xml', lang: 'ru', category: 'news' },
  { id: 'interfax', name: 'Интерфакс', url: 'https://www.interfax.ru/rss.asp', lang: 'ru', category: 'news' },
  { id: 'seekingalpha', name: 'Seeking Alpha', url: 'https://seekingalpha.com/feed.xml', lang: 'en', category: 'finance' },
  { id: 'rt', name: 'RT', url: 'https://russian.rt.com/rss', lang: 'ru', category: 'news' },
  { id: 'izvestia', name: 'Известия', url: 'https://iz.ru/xml/rss/all.xml', lang: 'ru', category: 'news' },

  // Finam — 7 RSS feeds (v7.8)
  { id: 'finam_companies', name: 'Финам: Новости компаний', url: 'https://www.finam.ru/analysis/conews/rsspoint/', lang: 'ru', category: 'finance' },
  { id: 'finam_news', name: 'Финам: Новости и комментарии', url: 'https://www.finam.ru/analysis/nslent/rsspoint/', lang: 'ru', category: 'finance' },
  { id: 'finam_forecasts', name: 'Финам: Сценарии и прогнозы', url: 'https://www.finam.ru/analysis/forecasts/rsspoint/', lang: 'ru', category: 'finance' },
  { id: 'finam_world', name: 'Финам: Мировые рынки', url: 'https://www.finam.ru/international/advanced/rsspoint/', lang: 'ru', category: 'finance' },
  { id: 'finam_analytics', name: 'Финам: Обзор и идеи', url: 'https://www.finam.ru/analytics/rsspoint/', lang: 'ru', category: 'finance' },
  { id: 'finam_bonds_news', name: 'Финам: Облигации — Новости', url: 'https://www.finam.ru/bonds-news/rsspoint/', lang: 'ru', category: 'finance' },
  { id: 'finam_bonds_comments', name: 'Финам: Облигации — Комментарии', url: 'https://www.finam.ru/bonds-comments/rsspoint/', lang: 'ru', category: 'finance' },

  // International (12)
  { id: 'reuters', name: 'Reuters', url: 'https://ir.thomsonreuters.com/rss/news-releases.xml?items=50', lang: 'en', category: 'finance' },
  { id: 'bloomberg', name: 'Bloomberg', url: 'https://feeds.bloomberg.com/business/news.rss', lang: 'en', category: 'finance' },
  { id: 'techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', lang: 'en', category: 'tech' },
  { id: 'cnbc', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', lang: 'en', category: 'finance' },
  { id: 'ft', name: 'Financial Times', url: 'https://www.ft.com/?format=rss', lang: 'en', category: 'finance' },
  { id: 'wsj', name: 'WSJ', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', lang: 'en', category: 'finance' },
  { id: 'economist', name: 'The Economist', url: 'https://www.economist.com/latest/rss.xml', lang: 'en', category: 'news' },
  { id: 'forbes', name: 'Forbes', url: 'https://www.forbes.com/business/feed/', lang: 'en', category: 'business' },
  { id: 'cnn', name: 'CNN Business', url: 'https://rss.cnn.com/rss/money_news_international.rss', lang: 'en', category: 'news' },
  { id: 'bbc', name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', lang: 'en', category: 'news' },
  { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/uk/business/rss', lang: 'en', category: 'news' },

  // Tech (4)
  { id: 'verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', lang: 'en', category: 'tech' },
  { id: 'wired', name: 'Wired', url: 'https://www.wired.com/feed/rss', lang: 'en', category: 'tech' },
  { id: 'arstechnica', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', lang: 'en', category: 'tech' },
  { id: 'hackernews', name: 'Hacker News', url: 'https://news.ycombinator.com/rss', lang: 'en', category: 'tech' },

  // Crypto (2)
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', lang: 'en', category: 'crypto' },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', lang: 'en', category: 'crypto' },

  // Energy (2)
  { id: 'oilprice', name: 'OilPrice.com', url: 'https://oilprice.com/rss.xml', lang: 'en', category: 'energy' },
  { id: 'mining', name: 'Mining.com', url: 'https://www.mining.com/feed/', lang: 'en', category: 'energy' },
  { id: 'marketwatch', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', lang: 'en', category: 'finance' },
];

export const EN_SOURCES = RSS_SOURCES.filter(s => s.lang === 'en');
export const RU_SOURCES = RSS_SOURC