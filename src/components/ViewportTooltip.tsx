import { useEffect, useRef, useState, type ReactNode } from 'react'

interface ViewportTooltipProps {
  visible: boolean
  children: ReactNode
  className?: string
}

export default function ViewportTooltip({ visible, children, className = '' }: ViewportTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [offsetX, setOffsetX] = useState(0)

  useEffect(() => {
    if (!visible) {
      setOffsetX(0)
      return
    }

    const updatePosition = () => {
      const el = tooltipRef.current
      if (!el) return
      const margin = 8
      const rect = el.getBoundingClientRect()
      if (rect.left < margin) {
        setOffsetX(margin - rect.left)
      } else if (rect.right > window.innerWidth - margin) {
        setOffsetX(window.innerWidth - margin - rect.right)
      } else {
        setOffsetX(0)
      }
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [visible, children])

  if (!visible) return null

  return (
    <div
      ref={tooltipRef}
      className={`absolute bottom-full left-1/2 mb-2 pointer-events-none z-20 rounded-lg bg-gray-800 px-3 py-2 text-xs font-normal text-white shadow-lg ${className}`}
      style={{ transform: `translateX(calc(-50% + ${offsetX}px))` }}
    >
      {children}
      <div
        className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800"
        style={{ marginLeft: -offsetX }}
      />
    </div>
  )
}
