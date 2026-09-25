/**
 * Shown when a sync completes but no posts could be read.
 *
 * Reading nothing from a healthy response is the only failure here with no
 * visible symptom, and it cannot be diagnosed without seeing what X returned.
 * This reports the response's *structure* - keys and types - so the shape can
 * be shared without sharing the contents of anyone's feed.
 */

import { useState } from 'react';

import { getLastUnreadable } from '@/x/shape';
import './ShapeReport.css';

export function ShapeReport(): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const report = getLastUnreadable();

  if (!report) return null;

  const json = JSON.stringify(
    { operation: report.operation, shape: report.shape },
    null,
    2,
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="shape">
      <summary className="shape__summary">
        What X actually returned <span className="shape__op">{report.operation}</span>
      </summary>

      <p className="shape__note">
        Structure only - field names and types, no post content. Copy this and
        send it over and the parser can be fixed against it directly.
      </p>

      <button type="button" className="shape__copy" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy structure'}
      </button>

      <pre className="shape__pre">
        <code>{json}</code>
      </pre>
    </details>
  );
}
