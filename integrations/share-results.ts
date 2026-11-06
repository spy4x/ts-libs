/**
 * The numbers a channel reports for one shared copy of a post, in one shape for every channel.
 *
 * A blog that shares each post to Dev.to, Reddit, Hacker News and other channels reads back how
 * each copy did. Every reader in this package (`readDevtoArticleResults`,
 * `readRedditPostResults`, `readHackerNewsItemResults` and the others) answers this shape, so a
 * caller stores every channel's numbers the same way.
 *
 * @module
 */

/**
 * How one shared copy did. A field is `null` when the channel does not report it, never `0`, so a
 * caller can tell "nobody reacted" from "this channel has no reactions".
 *
 * - `views`: times the copy was opened. Few channels report it, and some only to the owner.
 * - `reactions`: likes, favourites, hearts and the like, summed.
 * - `comments`: replies or comments, all levels counted.
 * - `score`: a ranking number the channel computes, such as Reddit's or Hacker News's points.
 */
export interface ShareResults {
  views: number | null
  reactions: number | null
  comments: number | null
  score: number | null
}
