import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

interface CopyableProps {
  text: string;
  className?: string;
  children?: ReactNode;
}

/** Click-to-copy text, with brief "copied" feedback. Stops the click from
 * bubbling to a parent handler (e.g. a node/edge click that would otherwise
 * also open a popup). */
export function Copyable({ text, className, children }: CopyableProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    },
    [text],
  );

  return (
    <span
      className={`copyable ${copied ? 'copied' : ''} ${className ?? ''}`.trim()}
      title={copied ? 'Copied!' : `Click to copy: ${text}`}
      onClick={handleClick}
    >
      {children ?? text}
    </span>
  );
}
