// The BC Consulting rings, the start screen's and setup wizard's logo: three crescents that whirl round the mark's
// centre and rest in the logo's pose between whirls (styles.css .bc-rings). Reduced motion stops them through the
// global rule.

/** The animated rings mark; decorative, so hidden from screen readers. */
export function BcRings({ className = 'start-logo' }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      <svg className="bc-rings" viewBox="0 0 691.16 709.22" focusable="false">
        <path
          className="bc-ring bc-ring-ocean"
          d="M543.75,88.45c64.9,64.05,100.18,156.62,87.53,254.03-21.48,165.42-172.99,282.12-338.41,260.64-51.16-6.64-97.66-25.74-136.85-53.82,45.32,44.73,105.09,75.56,173.11,84.39,165.42,21.48,316.94-95.22,338.41-260.64,14.83-114.26-36.26-221.87-123.79-284.59Z"
        />
        <path
          className="bc-ring bc-ring-sky"
          d="M678.63,411.56c-28.93,96.75-101.13,179.34-202.97,217.57-172.94,64.93-365.78-22.63-430.71-195.57-20.08-53.49-25.56-108.88-18.46-161.8-20.2,67.56-19.3,142.03,7.4,213.14,64.93,172.94,257.77,260.5,430.71,195.57,119.45-44.85,198.16-150.72,214.03-268.91Z"
        />
        <path
          className="bc-ring bc-ring-navy"
          d="M309.5,8.01c87.5,7.74,170.49,54.84,220.87,134.94,85.55,136.03,44.64,315.65-91.39,401.21-42.07,26.46-88.31,40.81-134.65,44,61.1,5.41,124.4-8.37,180.34-43.55,136.03-85.55,176.94-265.18,91.39-401.21C516.96,49.44,412.99.88,309.5,8.01Z"
        />
      </svg>
    </div>
  );
}
