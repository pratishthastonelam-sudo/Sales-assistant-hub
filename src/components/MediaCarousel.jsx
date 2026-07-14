import { useState, useRef } from 'react'

/**
 * Responsive carousel grid for displaying retrieved Google Drive images.
 * - If 1 image: full width
 * - If 2 images: side by side
 * - If 3+ images: horizontal scroll carousel with snap
 */
export default function MediaCarousel({ media }) {
  const scrollRef = useRef(null)
  const [lightbox, setLightbox] = useState(null)

  if (!media || media.length === 0) return null

  const scrollLeft = () => {
    scrollRef.current?.scrollBy({ left: -300, behavior: 'smooth' })
  }

  const scrollRight = () => {
    scrollRef.current?.scrollBy({ left: 300, behavior: 'smooth' })
  }

  // Single image — full width
  if (media.length === 1) {
    const img = media[0]
    return (
      <>
        <div
          className="overflow-hidden rounded-xl ring-1 ring-gray-200"
          onClick={() => setLightbox(img)}
        >
          <img
            src={img.thumbnail || img.url || img}
            alt={img.name || 'Retrieved image'}
            className="w-full cursor-pointer object-cover transition hover:opacity-90"
            loading="lazy"
          />
        </div>
        {img.name && (
          <p className="mt-1 truncate text-xs text-gray-400">{img.name}</p>
        )}
        {lightbox && <Lightbox image={lightbox} onClose={() => setLightbox(null)} />}
      </>
    )
  }

  // Two images — side by side
  if (media.length === 2) {
    return (
      <>
        <div className="grid grid-cols-2 gap-2">
          {media.map((img, idx) => (
            <div
              key={idx}
              className="overflow-hidden rounded-xl ring-1 ring-gray-200"
              onClick={() => setLightbox(img)}
            >
              <img
                src={img.thumbnail || img.url || img}
                alt={img.name || `Image ${idx + 1}`}
                className="h-32 w-full cursor-pointer object-cover transition hover:opacity-90"
                loading="lazy"
              />
            </div>
          ))}
        </div>
        {lightbox && <Lightbox image={lightbox} onClose={() => setLightbox(null)} />}
      </>
    )
  }

  // 3+ images — horizontal scroll carousel
  return (
    <>
      <div className="relative">
        {/* Left arrow */}
        <button
          onClick={scrollLeft}
          className="absolute left-0 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow-md ring-1 ring-gray-200 transition hover:bg-white"
        >
          <svg className="h-4 w-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Scroll container */}
        <div
          ref={scrollRef}
          className="carousel-scroll flex gap-2 overflow-x-auto rounded-xl pb-1 scrollbar-thin"
          style={{ scrollBehavior: 'smooth' }}
        >
          {media.map((img, idx) => (
            <div
              key={idx}
              className="carousel-item shrink-0 overflow-hidden rounded-xl ring-1 ring-gray-200"
              onClick={() => setLightbox(img)}
            >
              <img
                src={img.thumbnail || img.url || img}
                alt={img.name || `Image ${idx + 1}`}
                className="h-32 w-44 cursor-pointer object-cover transition hover:opacity-90"
                loading="lazy"
              />
              {img.name && (
                <p className="truncate bg-white px-2 py-1 text-xs text-gray-500">
                  {img.name}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Right arrow */}
        <button
          onClick={scrollRight}
          className="absolute right-0 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow-md ring-1 ring-gray-200 transition hover:bg-white"
        >
          <svg className="h-4 w-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Image count badge */}
      <div className="mt-1 flex items-center gap-1 text-xs text-gray-400">
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        {media.length} images found
      </div>

      {lightbox && <Lightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </>
  )
}

/**
 * Full-screen lightbox overlay
 */
function Lightbox({ image, onClose }) {
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async (e) => {
    e.stopPropagation()
    const src = image.url || image.thumbnail || image
    const filename = image.name || 'image.jpg'

    try {
      setDownloading(true)
      const resp = await fetch(src)
      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)

      const link = document.createElement('a')
      link.href = blobUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(blobUrl)
    } catch (err) {
      console.error('Download failed:', err)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 animate-fade-in"
      onClick={onClose}
    >
      <button
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white transition hover:bg-white/30"
        onClick={onClose}
      >
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <img
        src={image.url || image.thumbnail || image}
        alt={image.name || 'Full size image'}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      {image.name && (
        <p className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-lg bg-white/10 px-4 py-2 text-sm text-white">
          {image.name}
        </p>
      )}
      <div className="absolute bottom-6 right-6 flex items-center gap-2">
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-1 rounded-lg bg-white/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/30 disabled:opacity-60"
        >
          {downloading ? 'Downloading…' : 'Download'}
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
          </svg>
        </button>
        {image.web_view_link && (
          <a
            href={image.web_view_link}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
            onClick={(e) => e.stopPropagation()}
          >
            Open in Drive
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
      </div>
    </div>
  )
}