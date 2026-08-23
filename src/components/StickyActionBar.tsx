import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useReducedMotion } from "../context/ReducedMotionContext";

interface StickyActionBarProps {
  hasLines: boolean;
  hasUtilized: boolean;
}

export function StickyActionBar({
  hasLines,
  hasUtilized,
}: StickyActionBarProps) {
  const [isVisible, setIsVisible] = useState(false);
  const { isReducedMotionActive } = useReducedMotion();
  const navigate = useNavigate();

  useEffect(() => {
    const handleScroll = () => setIsVisible(window.scrollY > 300);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleDraw = useCallback(() => {
    if (!hasLines) return;
    navigate("/draw-credit");
  }, [hasLines, navigate]);

  const handleRepay = useCallback(() => {
    if (!hasUtilized) return;
    navigate("/repay");
  }, [hasUtilized, navigate]);

  const handleViewLines = useCallback(() => {
    navigate("/credit-lines");
  }, [navigate]);

  return (
    <div
      role="region"
      aria-label="Quick actions"
      data-visible={isVisible}
      className={`sticky-action-bar${
        isVisible ? " sticky-action-bar--visible" : ""
      }${isReducedMotionActive ? " sticky-action-bar--no-motion" : ""}`}
    >
      <div className="sticky-action-bar__inner">
        {hasLines && (
          <button
            type="button"
            className="sticky-action-bar__btn sticky-action-bar__btn--primary"
            onClick={handleDraw}
            aria-label="Draw credit"
          >
            <span aria-hidden="true" className="sticky-action-bar__icon">
              ↗
            </span>
            <span>Draw Credit</span>
          </button>
        )}
        {hasUtilized && (
          <button
            type="button"
            className="sticky-action-bar__btn sticky-action-bar__btn--success"
            onClick={handleRepay}
            aria-label="Repay credit"
          >
            <span aria-hidden="true" className="sticky-action-bar__icon">
              ↙
            </span>
            <span>Repay</span>
          </button>
        )}
        <button
          type="button"
          className="sticky-action-bar__btn sticky-action-bar__btn--secondary"
          onClick={handleViewLines}
          aria-label="View all credit lines"
        >
          <span aria-hidden="true" className="sticky-action-bar__icon">
            📋
          </span>
          <span>Credit Lines</span>
        </button>
      </div>
    </div>
  );
}
