function SidebarSkeleton() {
  return <div className="sidebar-skeleton" aria-hidden="true">{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function ConversationSkeleton({ label }: { label: string }) {
  return <div className="conversation-skeleton" role="status"><span>{label}</span><i /><i /><i /></div>;
}

export { SidebarSkeleton, ConversationSkeleton };
