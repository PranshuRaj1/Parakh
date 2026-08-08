export default function Logo({ className = '' }: { className?: string }) {
  return (
    <>
      {/* Light Mode Logo */}
      <svg
        viewBox="0 0 520 140"
        xmlns="http://www.w3.org/2000/svg"
        className={`block dark:hidden ${className}`}
      >
        {/* mark */}
        <g
          transform="translate(10,10)"
          stroke="#15161A"
          strokeWidth="7.5"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M 30 55 V 30 H 55" />
          <path d="M 90 47 V 30 H 73" />
          <path d="M 30 73 V 90 H 47" />
          <path d="M 65 90 H 90 V 65" />
        </g>
        <line
          x1="38"
          y1="80"
          x2="82"
          y2="38"
          stroke="#F0A93D"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.6"
          transform="translate(10,10)"
        />
        <circle cx="60" cy="60" r="7.5" fill="#F0A93D" transform="translate(10,10)" />

        {/* wordmark */}
        <text
          x="145"
          y="88"
          fontFamily="'JetBrains Mono','SFMono-Regular','Consolas',monospace"
          fontSize="52"
          fontWeight="600"
          letterSpacing="0.5"
          fill="#15161A"
        >
          parakh
        </text>
      </svg>

      {/* Dark Mode Logo */}
      <svg
        viewBox="0 0 520 140"
        xmlns="http://www.w3.org/2000/svg"
        className={`hidden dark:block ${className}`}
      >
        {/* mark */}
        <g
          transform="translate(10,10)"
          stroke="#EDEAE2"
          strokeWidth="7.5"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M 30 55 V 30 H 55" />
          <path d="M 90 47 V 30 H 73" />
          <path d="M 30 73 V 90 H 47" />
          <path d="M 65 90 H 90 V 65" />
        </g>
        <line
          x1="38"
          y1="80"
          x2="82"
          y2="38"
          stroke="#F0A93D"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.65"
          transform="translate(10,10)"
        />
        <circle cx="60" cy="60" r="7.5" fill="#F0A93D" transform="translate(10,10)" />

        {/* wordmark */}
        <text
          x="145"
          y="88"
          fontFamily="'JetBrains Mono','SFMono-Regular','Consolas',monospace"
          fontSize="52"
          fontWeight="600"
          letterSpacing="0.5"
          fill="#EDEAE2"
        >
          parakh
        </text>
      </svg>
    </>
  );
}
