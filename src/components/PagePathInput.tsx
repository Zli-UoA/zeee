import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Input } from '@cloudflare/kumo';
import { FolderIcon } from '@phosphor-icons/react';
import {
  directorySuggestions,
  nextActiveIndex,
  type DirectorySuggestion,
  type PagePathPage,
} from '../shared/pagePath';

type InputSize = 'xs' | 'sm' | 'base' | 'lg';

export type PagePathInputProps = {
  value: string;
  onChange: (value: string) => void;
  pages: PagePathPage[];
  ariaLabel: string;
  placeholder?: string;
  name?: string;
  required?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  size?: InputSize;
  className?: string;
  invalid?: boolean;
  errorId?: string;
  disabled?: boolean;
  suggestionsLimit?: number;
  onBlur?: () => void;
  onEnter?: () => void;
};

type SuggestionListboxProps = {
  id: string;
  baseId: string;
  suggestions: DirectorySuggestion[];
  activeIndex: number;
  onActivate: (index: number) => void;
  onSelect: (suggestion: DirectorySuggestion) => void;
};

export function PathSuggestionListbox({
  id,
  baseId,
  suggestions,
  activeIndex,
  onActivate,
  onSelect,
}: SuggestionListboxProps) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="ディレクトリ候補"
      className="absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base p-1 shadow-lg"
    >
      {suggestions.map((suggestion, index) => (
        <li
          key={suggestion.path}
          id={`${baseId}-option-${index}`}
          role="option"
          aria-selected={index === activeIndex}
          data-kind="directory-suggestion"
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onActivate(index)}
          onClick={() => onSelect(suggestion)}
          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
            index === activeIndex
              ? 'bg-kumo-tint text-kumo-strong'
              : 'text-kumo-default hover:bg-kumo-tint'
          }`}
        >
          <FolderIcon size={14} className="shrink-0 text-kumo-subtle" />
          <span className="min-w-0 flex-1 truncate font-mono">{suggestion.value}</span>
        </li>
      ))}
    </ul>
  );
}

export const PagePathInput = forwardRef<HTMLInputElement, PagePathInputProps>(
  function PagePathInput(
    {
      value,
      onChange,
      pages,
      ariaLabel,
      placeholder,
      name,
      required,
      maxLength,
      autoFocus,
      size = 'base',
      className,
      invalid,
      errorId,
      disabled,
      suggestionsLimit = 8,
      onBlur,
      onEnter,
    },
    forwardedRef,
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    const baseId = useId().replaceAll(':', '');
    const listboxId = `${baseId}-listbox`;
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const suggestions = useMemo(
      () => directorySuggestions(pages, value, suggestionsLimit),
      [pages, value, suggestionsLimit],
    );
    const showSuggestions = open && suggestions.length > 0;

    const setRef = useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    useEffect(() => {
      setActiveIndex((current) => {
        if (!suggestions.length) return -1;
        return current < 0 ? 0 : Math.min(current, suggestions.length - 1);
      });
    }, [suggestions]);

    function selectSuggestion(suggestion: DirectorySuggestion) {
      onChange(suggestion.value);
      setActiveIndex(0);
      setOpen(true);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(suggestion.value.length, suggestion.value.length);
      });
    }

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      const native = event.nativeEvent;
      if (native.isComposing || event.key === 'Process') return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!suggestions.length) return;
        setOpen(true);
        setActiveIndex((current) =>
          nextActiveIndex(current, event.key === 'ArrowDown' ? 1 : -1, suggestions.length),
        );
        return;
      }
      if (event.key === 'Enter') {
        const suggestion = showSuggestions
          ? (suggestions[activeIndex] ?? suggestions[0])
          : undefined;
        if (suggestion) {
          event.preventDefault();
          selectSuggestion(suggestion);
          return;
        }
        if (onEnter) {
          event.preventDefault();
          onEnter();
        }
        return;
      }
      if (event.key === 'Escape') {
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }
      if (event.key === 'Tab' && showSuggestions) {
        const suggestion = suggestions[activeIndex] ?? suggestions[0];
        if (suggestion) {
          event.preventDefault();
          selectSuggestion(suggestion);
        }
      }
    }

    return (
      <div className={`relative ${className ?? ''}`}>
        <Input
          ref={setRef}
          value={value}
          name={name}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            onBlur?.();
          }}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-activedescendant={
            showSuggestions && activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined
          }
          aria-invalid={invalid || undefined}
          aria-describedby={errorId}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={placeholder}
          required={required}
          maxLength={maxLength}
          autoFocus={autoFocus}
          size={size}
          variant={invalid ? 'error' : 'default'}
          disabled={disabled}
          className="w-full"
        />
        {showSuggestions ? (
          <PathSuggestionListbox
            id={listboxId}
            baseId={baseId}
            suggestions={suggestions}
            activeIndex={activeIndex}
            onActivate={setActiveIndex}
            onSelect={selectSuggestion}
          />
        ) : null}
      </div>
    );
  },
);
