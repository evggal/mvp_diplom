import { useEffect, useState } from "react";

interface DismissibleErrorProps {
  message: string | null | undefined;
  compact?: boolean;
  on_dismiss?: () => void;
}

export function DismissibleError({ message, compact = false, on_dismiss }: DismissibleErrorProps) {
  const [is_visible, setIsVisible] = useState(Boolean(message));

  useEffect(() => {
    setIsVisible(Boolean(message));
  }, [message]);

  if (!message || !is_visible) {
    return null;
  }

  function HandleClose() {
    setIsVisible(false);
    on_dismiss?.();
  }

  return (
    <div className={`error-box ${compact ? "compact" : ""}`} role="alert">
      <span className="error-box-message">{message}</span>
      <button
        type="button"
        className="error-box-close"
        aria-label="Close error message"
        onClick={HandleClose}
      >
        x
      </button>
    </div>
  );
}
