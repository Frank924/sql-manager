import { useEffect, useRef } from 'react';
import { IconX, IconSearch, IconInbox, IconChevronDown } from '@tabler/icons-react';

export function Badge({ children, tone = 'neutral' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function PageHeading({ title, subtitle, children }) { return <header className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="heading-actions">{children}</div></header>; }
export function SearchInput({ value, onChange, placeholder = '搜索', label }) { return <label className="search-input"><IconSearch size={19} stroke={1.7}/><input aria-label={label || placeholder} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}/></label>; }
export function Select({ children, ...props }) { return <span className="select-wrap"><select {...props}>{children}</select><IconChevronDown size={16}/></span>; }
export function EmptyState({ title = '暂无记录', description, children }) { return <div className="empty-state"><IconInbox size={36} stroke={1.3}/><h3>{title}</h3><p>{description}</p>{children}</div>; }
export function Modal({ title, description, children, footer, onClose, wide = false }) {
  const ref = useRef(null);
  const id = useRef(`dialog-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => { const el = ref.current; el.showModal(); return () => el.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={id} onCancel={e => {e.preventDefault();onClose();}} onClick={e => { if(e.target===ref.current) onClose(); }}>
    <div className="modal-inner"><header className="modal-heading"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><IconX size={22}/></button></header><div className="modal-body">{children}</div>{footer && <footer className="modal-footer">{footer}</footer>}</div>
  </dialog>;
}
