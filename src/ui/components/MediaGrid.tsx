/**
 * Post media, laid out the way X lays it out: one image fills the width at its
 * own aspect ratio, two split vertically, three put one tall tile beside two
 * stacked, four form a 2x2.
 *
 * Video is shown as its poster frame with a play affordance that opens the
 * post on X rather than playing inline - X serves HLS for most video, which a
 * bare <video> cannot play without shipping a streaming library.
 */

import type { MediaItem } from '@/x/types';
import './MediaGrid.css';

interface MediaGridProps {
  media: MediaItem[];
  /** Where the play button and image clicks lead. */
  permalink: string;
}

function aspectRatio(item: MediaItem): string | undefined {
  if (!item.width || !item.height) return undefined;
  return `${item.width} / ${item.height}`;
}

export function MediaGrid({ media, permalink }: MediaGridProps): React.JSX.Element | null {
  if (media.length === 0) return null;

  const items = media.slice(0, 4);
  const count = items.length;
  const single = count === 1;

  return (
    <div
      className={`media media--${count}`}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item, index) => (
        <a
          key={`${item.url}-${index}`}
          className="media__tile"
          href={permalink}
          target="_blank"
          rel="noreferrer noopener"
          // A lone image keeps its true shape; grouped tiles are cropped to
          // equal cells, same as X.
          style={single ? { aspectRatio: aspectRatio(item) ?? '16 / 9' } : undefined}
        >
          <img
            src={item.url}
            alt={item.altText ?? ''}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
          {item.kind !== 'photo' && (
            <span className="media__play" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          )}
          {item.kind === 'gif' && <span className="media__badge">GIF</span>}
          {item.altText && <span className="media__alt">ALT</span>}
        </a>
      ))}
    </div>
  );
}
