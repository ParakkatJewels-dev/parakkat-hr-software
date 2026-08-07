export default function IconInput({ icon: Icon, inputClassName = '', className = '', ...props }) {
  return (
    <div className={`relative ${className}`}>
      {Icon && (
        <Icon
          size={13}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#0ea971]"
          aria-hidden="true"
        />
      )}
      <input {...props} className={`${inputClassName}${Icon ? ' pl-8' : ''}`} />
    </div>
  );
}
