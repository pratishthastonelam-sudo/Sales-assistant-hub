import MediaCarousel from './MediaCarousel.jsx'

function getFileIcon(type) {
  if (!type) return 'file'
  if (type.includes('pdf')) return 'pdf'
  if (type.includes('sheet') || type.includes('excel') || type.includes('csv')) return 'spreadsheet'
  if (type.includes('word') || type.includes('document')) return 'doc'
  if (type.includes('presentation') || type.includes('powerpoint')) return 'presentation'
  return 'file'
}

function FileIcon({ type }) {
  const icon = getFileIcon(type)
  const colors = {
    pdf: 'text-red-500',
    spreadsheet: 'text-green-500',
    doc: 'text-blue-500',
    presentation: 'text-orange-500',
    file: 'text-gray-400',
  }
  const paths = {
    pdf: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z M9 9h1.5a1.5 1.5 0 010 3H9v2 M14 9h1v6"
      />
    ),
    spreadsheet: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 17v-2m3 2v-4m3 4v-6M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z M7 8h10"
      />
    ),
    doc: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    ),
    presentation: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 12l3-3 3 3 3-3 M9 4v1m6-1v1 M5 8h14a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1V9a1 1 0 011-1z M12 16v4"
      />
    ),
    file: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    ),
  }

  return (
    <svg
      className={`h-5 w-5 ${colors[icon]}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      {paths[icon]}
    </svg>
  )
}

export default function ChatMessage({ message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex py-3 animate-slide-up ${isUser ? 'justify-end' : 'justify-start'}`}>
      {/* Avatar for assistant */}
      {!isUser && (
        <div className="mr-2 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 shadow-sm">
          <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </div>
      )}

      <div className={`max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Bubble */}
        <div
          className={`rounded-2xl px-4 py-3 text-sm shadow-sm ${
            isUser
              ? 'rounded-br-sm bg-brand-600 text-white'
              : 'rounded-bl-sm bg-white text-gray-800 ring-1 ring-gray-100'
          }`}
        >
          <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>

          {/* Image carousel */}
          {!isUser && message.media && message.media.length > 0 && (
            <div className="mt-3">
              <MediaCarousel media={message.media} />
            </div>
          )}

          {/* Document pills */}
          {!isUser && message.documents && message.documents.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.documents.map((doc, idx) => (
                <a
                  key={idx}
                  href={doc.url || doc.web_view_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                    isUser
                      ? 'bg-brand-500/20 text-white hover:bg-brand-500/30'
                      : 'bg-gray-50 text-gray-700 ring-1 ring-gray-200 hover:bg-gray-100'
                  }`}
                >
                  <FileIcon type={doc.mime_type || doc.type} />
                  <span className="max-w-[180px] truncate">
                    {doc.name || doc.filename || 'Document'}
                  </span>
                  <svg className="h-3 w-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Timestamp */}
        {message.created_at && (
          <p className={`mt-1 px-2 text-xs text-gray-400 ${isUser ? 'text-right' : 'text-left'}`}>
            {new Date(message.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        )}
      </div>
    </div>
  )
}
