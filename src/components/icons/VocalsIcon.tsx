interface VocalsIconProps {
  className?: string;
  isActive?: boolean;
}

export const VocalsIcon = ({ className = "w-4 h-4", isActive = true }: VocalsIconProps) => {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Face profile - nose and lips */}
      <path d="M4 4 C6 4, 8 6, 8 8 L8 10 C8 10, 10 10, 10 12 C10 14, 8 14, 8 14 L8 15 C8 16, 6 18, 4 18" />
      
      {/* Sound waves - only show when active */}
      {isActive && (
        <>
          <path d="M14 9 C15.5 10, 15.5 14, 14 15" opacity="0.9" />
          <path d="M17 7 C19.5 9, 19.5 15, 17 17" opacity="0.7" />
          <path d="M20 5 C23.5 8, 23.5 16, 20 19" opacity="0.5" />
        </>
      )}
      
      {/* X mark when muted */}
      {!isActive && (
        <path d="M16 8 L22 16 M22 8 L16 16" strokeWidth="2" />
      )}
    </svg>
  );
};

export default VocalsIcon;
