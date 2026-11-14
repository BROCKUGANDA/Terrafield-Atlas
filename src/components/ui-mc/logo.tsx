'use client';

import React from 'react';

/**
 * TerraField Atlas mission patch (original mark, inspired by flight-emblem
 * conventions: orbital ring, tracking dot, graticule globe).
 */
export function MissionPatch({ className, animated = true }: { className?: string; animated?: boolean }) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label="TerraField Atlas mission patch"
      className={className}
      fill="none"
    >
      {/* Void disc */}
      <circle cx="24" cy="24" r="22" fill="#070C18" stroke="rgba(151,174,224,0.35)" strokeWidth="1" />
      {/* Graticule globe */}
      <circle cx="24" cy="24" r="12.5" stroke="#4CC3FF" strokeWidth="1.2" opacity="0.9" />
      <ellipse cx="24" cy="24" rx="12.5" ry="5" stroke="#4CC3FF" strokeWidth="0.8" opacity="0.55" />
      <ellipse cx="24" cy="24" rx="5" ry="12.5" stroke="#4CC3FF" strokeWidth="0.8" opacity="0.55" />
      <line x1="11.5" y1="24" x2="36.5" y2="24" stroke="#4CC3FF" strokeWidth="0.8" opacity="0.4" />
      {/* Orbital ring */}
      <ellipse cx="24" cy="24" rx="19" ry="8" stroke="rgba(151,174,224,0.6)" strokeWidth="1" transform="rotate(-24 24 24)" />
      {/* Satellite + command red accents */}
      <circle cx="38.5" cy="16.5" r="2.6" fill="#FC3D21" />
      <circle cx="38.5" cy="16.5" r="4.8" stroke="#FC3D21" strokeWidth="0.8" opacity="0.45">
        {animated && (
          <animate attributeName="r" values="4.8;6.6;4.8" dur="2.6s" repeatCount="indefinite" />
        )}
      </circle>
      {/* Ground-station tick on globe */}
      <circle cx="18" cy="28.5" r="1.6" fill="#45E39A" />
    </svg>
  );
}
