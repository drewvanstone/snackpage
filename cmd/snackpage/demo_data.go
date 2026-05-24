package main

// demoData is the generic 100-bookmark seed set for `snackpage demo`.
// Categories: search, social, shopping, streaming, news, dev, cloud,
// productivity, learning, maps/travel, finance, email, fun/reference.
var demoData = []demoEntry{
	// Search & portals (8)
	{"Google", "https://www.google.com", []string{"search"}, nil},
	{"Bing", "https://www.bing.com", []string{"search"}, nil},
	{"DuckDuckGo", "https://duckduckgo.com", []string{"search", "privacy"}, nil},
	{"Wikipedia", "https://en.wikipedia.org", []string{"reference"}, nil},
	{"Yahoo", "https://www.yahoo.com", []string{"search", "portal"}, nil},
	{"Yandex", "https://yandex.com", []string{"search"}, nil},
	{"Baidu", "https://www.baidu.com", []string{"search"}, nil},
	{"Brave Search", "https://search.brave.com", []string{"search", "privacy"}, nil},

	// Social (12)
	{"Facebook", "https://www.facebook.com", []string{"social"}, nil},
	{"X (Twitter)", "https://x.com", []string{"social"}, []string{"twitter"}},
	{"Instagram", "https://www.instagram.com", []string{"social", "photos"}, nil},
	{"LinkedIn", "https://www.linkedin.com", []string{"social", "professional"}, nil},
	{"Reddit", "https://www.reddit.com", []string{"social", "forum"}, nil},
	{"TikTok", "https://www.tiktok.com", []string{"social", "video"}, nil},
	{"Pinterest", "https://www.pinterest.com", []string{"social"}, nil},
	{"Threads", "https://www.threads.net", []string{"social"}, nil},
	{"Mastodon", "https://joinmastodon.org", []string{"social"}, []string{"fediverse"}},
	{"Bluesky", "https://bsky.app", []string{"social"}, nil},
	{"Snapchat", "https://www.snapchat.com", []string{"social", "messaging"}, nil},
	{"Discord", "https://discord.com", []string{"social", "chat"}, nil},

	// Shopping (10)
	{"Amazon", "https://www.amazon.com", []string{"shopping"}, nil},
	{"eBay", "https://www.ebay.com", []string{"shopping", "auction"}, nil},
	{"Etsy", "https://www.etsy.com", []string{"shopping", "handmade"}, nil},
	{"Walmart", "https://www.walmart.com", []string{"shopping"}, nil},
	{"Target", "https://www.target.com", []string{"shopping"}, nil},
	{"Best Buy", "https://www.bestbuy.com", []string{"shopping", "electronics"}, nil},
	{"Costco", "https://www.costco.com", []string{"shopping"}, nil},
	{"AliExpress", "https://www.aliexpress.com", []string{"shopping"}, nil},
	{"Wayfair", "https://www.wayfair.com", []string{"shopping", "furniture"}, nil},
	{"Newegg", "https://www.newegg.com", []string{"shopping", "electronics"}, nil},

	// Streaming & media (11)
	{"YouTube", "https://www.youtube.com", []string{"video", "streaming"}, nil},
	{"Netflix", "https://www.netflix.com", []string{"streaming", "movies"}, nil},
	{"Spotify", "https://www.spotify.com", []string{"music", "streaming"}, nil},
	{"Twitch", "https://www.twitch.tv", []string{"streaming", "gaming"}, nil},
	{"Disney+", "https://www.disneyplus.com", []string{"streaming", "movies"}, nil},
	{"Hulu", "https://www.hulu.com", []string{"streaming"}, nil},
	{"Max", "https://www.max.com", []string{"streaming"}, []string{"hbo"}},
	{"Apple TV+", "https://tv.apple.com", []string{"streaming"}, nil},
	{"Apple Music", "https://music.apple.com", []string{"music"}, nil},
	{"SoundCloud", "https://soundcloud.com", []string{"music"}, nil},
	{"Vimeo", "https://vimeo.com", []string{"video"}, nil},

	// Mainstream news (10)
	{"The New York Times", "https://www.nytimes.com", []string{"news"}, []string{"nyt"}},
	{"The Washington Post", "https://www.washingtonpost.com", []string{"news"}, []string{"wapo"}},
	{"BBC News", "https://www.bbc.com/news", []string{"news"}, nil},
	{"CNN", "https://www.cnn.com", []string{"news"}, nil},
	{"Reuters", "https://www.reuters.com", []string{"news"}, nil},
	{"AP News", "https://apnews.com", []string{"news"}, []string{"associated press"}},
	{"NPR", "https://www.npr.org", []string{"news", "radio"}, nil},
	{"The Guardian", "https://www.theguardian.com", []string{"news"}, nil},
	{"Bloomberg", "https://www.bloomberg.com", []string{"news", "finance"}, nil},
	{"The Wall Street Journal", "https://www.wsj.com", []string{"news", "finance"}, []string{"wsj"}},

	// Tech news (5)
	{"Hacker News", "https://news.ycombinator.com", []string{"news", "tech"}, []string{"hn", "ycombinator"}},
	{"The Verge", "https://www.theverge.com", []string{"news", "tech"}, nil},
	{"TechCrunch", "https://techcrunch.com", []string{"news", "tech"}, nil},
	{"Ars Technica", "https://arstechnica.com", []string{"news", "tech"}, nil},
	{"Wired", "https://www.wired.com", []string{"news", "tech"}, nil},

	// Dev & code (8)
	{"GitHub", "https://github.com", []string{"code", "dev"}, nil},
	{"GitLab", "https://gitlab.com", []string{"code", "dev"}, nil},
	{"Stack Overflow", "https://stackoverflow.com", []string{"code", "dev"}, []string{"so"}},
	{"MDN Web Docs", "https://developer.mozilla.org", []string{"docs", "web", "dev"}, []string{"mdn", "mozilla developer"}},
	{"npm", "https://www.npmjs.com", []string{"dev", "package", "node"}, nil},
	{"PyPI", "https://pypi.org", []string{"dev", "package", "python"}, nil},
	{"Docker Hub", "https://hub.docker.com", []string{"dev", "container"}, nil},
	{"CodePen", "https://codepen.io", []string{"dev", "web"}, nil},

	// Cloud (6)
	{"AWS", "https://aws.amazon.com", []string{"cloud"}, []string{"amazon web services"}},
	{"Google Cloud", "https://cloud.google.com", []string{"cloud"}, []string{"gcp"}},
	{"Azure", "https://azure.microsoft.com", []string{"cloud"}, nil},
	{"DigitalOcean", "https://www.digitalocean.com", []string{"cloud", "vps"}, nil},
	{"Vercel", "https://vercel.com", []string{"cloud", "deploy"}, nil},
	{"Cloudflare", "https://www.cloudflare.com", []string{"cloud", "cdn", "dns"}, nil},

	// Productivity (6)
	{"Notion", "https://www.notion.so", []string{"productivity", "notes"}, nil},
	{"Trello", "https://trello.com", []string{"productivity", "kanban"}, nil},
	{"Asana", "https://asana.com", []string{"productivity", "tasks"}, nil},
	{"Linear", "https://linear.app", []string{"productivity", "tasks"}, nil},
	{"Slack", "https://slack.com", []string{"communication"}, nil},
	{"Zoom", "https://zoom.us", []string{"communication", "video"}, nil},

	// Learning (5)
	{"Khan Academy", "https://www.khanacademy.org", []string{"learning"}, nil},
	{"Coursera", "https://www.coursera.org", []string{"learning"}, nil},
	{"edX", "https://www.edx.org", []string{"learning"}, nil},
	{"Duolingo", "https://www.duolingo.com", []string{"learning", "languages"}, nil},
	{"MIT OpenCourseWare", "https://ocw.mit.edu", []string{"learning"}, []string{"mit ocw"}},

	// Maps & travel (5)
	{"Google Maps", "https://maps.google.com", []string{"maps"}, nil},
	{"Airbnb", "https://www.airbnb.com", []string{"travel"}, nil},
	{"Booking.com", "https://www.booking.com", []string{"travel"}, nil},
	{"Tripadvisor", "https://www.tripadvisor.com", []string{"travel"}, nil},
	{"Uber", "https://www.uber.com", []string{"travel", "transport"}, nil},

	// Finance (5)
	{"PayPal", "https://www.paypal.com", []string{"finance", "payment"}, nil},
	{"Stripe", "https://stripe.com", []string{"finance", "payment"}, nil},
	{"Robinhood", "https://robinhood.com", []string{"finance", "investing"}, nil},
	{"Coinbase", "https://www.coinbase.com", []string{"finance", "crypto"}, nil},
	{"Mint", "https://mint.intuit.com", []string{"finance", "budget"}, nil},

	// Email (3)
	{"Gmail", "https://mail.google.com", []string{"email"}, nil},
	{"Outlook", "https://outlook.live.com", []string{"email"}, nil},
	{"ProtonMail", "https://proton.me", []string{"email", "privacy"}, nil},

	// Fun & reference (6)
	{"Imgur", "https://imgur.com", []string{"images", "fun"}, nil},
	{"XKCD", "https://xkcd.com", []string{"comic", "fun"}, nil},
	{"Internet Archive", "https://archive.org", []string{"reference", "archive"}, nil},
	{"Wayback Machine", "https://web.archive.org", []string{"reference", "archive"}, nil},
	{"Lobsters", "https://lobste.rs", []string{"news", "tech"}, nil},
	{"Quora", "https://www.quora.com", []string{"qa"}, nil},
}
