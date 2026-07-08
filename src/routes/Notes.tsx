import { useCallback, useEffect, useRef, useState } from "react";
import { Clipboard, FileText, Mic, Plus, Trash2 } from "lucide-react";
import { deleteNote, getNotes, Note, saveNote } from "../lib/ipc";
import { useAppStore } from "../lib/store";

function generateId() {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isRecording, isProcessing, startRecording, stopRecording, lastTranscript } = useAppStore();

  const activeNote = notes.find((note) => note.id === activeNoteId);

  const load = useCallback(async () => {
    const data = await getNotes();
    setNotes(data);
    if (data.length > 0 && !activeNoteId) {
      setActiveNoteId(data[0].id);
      setContent(data[0].content);
      setTitle(data[0].title);
    }
  }, [activeNoteId]);

  useEffect(() => {
    load().catch(console.error);
  }, []);

  useEffect(() => {
    if (lastTranscript && activeNoteId) {
      setContent((prev) => `${prev}${prev ? " " : ""}${lastTranscript.cleaned}`);
    }
  }, [lastTranscript, activeNoteId]);

  useEffect(() => {
    if (!activeNoteId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveNote(activeNoteId, title || "Untitled", content, "default").catch(console.error);
    }, 900);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [content, title, activeNoteId]);

  const createNote = async () => {
    const id = generateId();
    await saveNote(id, "Untitled Note", "", "default");
    const newNote: Note = {
      id,
      title: "Untitled Note",
      content: "",
      folder: "default",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setNotes((prev) => [newNote, ...prev]);
    setActiveNoteId(id);
    setContent("");
    setTitle("Untitled Note");
    setTimeout(() => textareaRef.current?.focus(), 80);
  };

  const handleDeleteNote = async (id: string) => {
    await deleteNote(id);
    setNotes((prev) => {
      const remaining = prev.filter((note) => note.id !== id);
      if (activeNoteId === id) {
        const next = remaining[0];
        setActiveNoteId(next?.id ?? null);
        setContent(next?.content ?? "");
        setTitle(next?.title ?? "");
      }
      return remaining;
    });
  };

  const selectNote = (note: Note) => {
    if (activeNoteId) saveNote(activeNoteId, title || "Untitled", content, "default").catch(console.error);
    setActiveNoteId(note.id);
    setContent(note.content);
    setTitle(note.title);
  };

  return (
    <div className="page full">
      <div className="note-layout">
        <aside className="note-list">
          <div className="note-toolbar" style={{ justifyContent: "space-between" }}>
            <span className="section-label" style={{ margin: 0 }}>
              Notes
            </span>
            <button className="button icon borderless" onClick={createNote} aria-label="New note">
              <Plus size={15} />
            </button>
          </div>

          <div style={{ padding: "8px 0" }}>
            {notes.length === 0 && <p className="row-desc" style={{ padding: "0 14px" }}>No notes yet</p>}
            {notes.map((note) => (
              <div
                key={note.id}
                className={`note-item ${activeNoteId === note.id ? "active" : ""}`}
                onClick={() => selectNote(note)}
              >
                <FileText size={14} />
                <span className="truncate" style={{ flex: 1, fontSize: 13 }}>
                  {note.title || "Untitled"}
                </span>
                <button
                  className="button icon borderless"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDeleteNote(note.id).catch(console.error);
                  }}
                  aria-label="Delete note"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="note-editor">
          {activeNote || activeNoteId ? (
            <>
              <div className="note-toolbar">
                <input
                  className="note-title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Note title"
                />
                <button className={`button ${isRecording ? "danger" : ""}`} onClick={isRecording ? stopRecording : startRecording} disabled={isProcessing}>
                  <Mic size={14} />
                  {isProcessing ? "Processing" : isRecording ? "Stop" : "Dictate"}
                </button>
                <button className="button" onClick={() => navigator.clipboard.writeText(content)}>
                  <Clipboard size={14} />
                  Copy
                </button>
                <span className="subtle" style={{ fontSize: 12 }}>Autosaved</span>
              </div>
              <textarea
                ref={textareaRef}
                className="note-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Start typing, or dictate into this note."
              />
            </>
          ) : (
            <div className="empty-state" style={{ margin: 24 }}>
              <FileText size={42} />
              <h3>No note selected</h3>
              <p>Create a note, then dictate or type freely. Everything stays local.</p>
              <button className="button primary" style={{ marginTop: 14 }} onClick={createNote}>
                <Plus size={14} />
                New note
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
