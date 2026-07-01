import { Router } from 'express';

const router = Router();

interface GithubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

/**
 * GET /api/app/version
 *
 * Returns the latest Android APK version and download URL from GitHub Releases.
 * Environment:
 *   - APP_GITHUB_OWNER (default: vladfa2010)
 *   - APP_GITHUB_REPO  (default: pulse-frontend)
 *   - APP_ASSET_NAME   (default: PULSE-debug.apk)
 *   - GITHUB_TOKEN     (optional, increases API rate limit)
 */
router.get('/version', async (_req, res) => {
  const owner = process.env.APP_GITHUB_OWNER || 'vladfa2010';
  const repo = process.env.APP_GITHUB_REPO || 'pulse-frontend';
  const assetName = process.env.APP_ASSET_NAME || 'PULSE-debug.apk';
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.error('[AppVersion] GitHub API error:', response.status, text);
      return res.status(502).json({ error: 'Failed to fetch release info' });
    }

    const release = (await response.json()) as GithubRelease;
    const version = release.tag_name.replace(/^v/, '');
    const asset = release.assets.find(a => a.name === assetName);

    if (!asset) {
      console.error('[AppVersion] Asset not found:', assetName);
      return res.status(404).json({ error: 'APK asset not found in release' });
    }

    res.json({
      version,
      apkUrl: asset.browser_download_url,
      releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${release.tag_name}`,
    });
  } catch (err: any) {
    console.error('[AppVersion] Error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
