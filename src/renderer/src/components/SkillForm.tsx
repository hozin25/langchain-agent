import { useEffect, useState } from 'react'
import type { SkillConfig } from '@shared/types'

interface SkillFormProps {
  skill: SkillConfig | null
  onSave: (config: SkillConfig | Omit<SkillConfig, 'id'>) => void
  onCancel: () => void
}

export function SkillForm({ skill, onSave, onCancel }: SkillFormProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [filePath, setFilePath] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState('')

  useEffect(() => {
    if (skill) {
      setName(skill.name)
      setDescription(skill.description)
      setFilePath(skill.filePath)
      setEnabled(skill.enabled)
    } else {
      setName('')
      setDescription('')
      setFilePath('')
      setEnabled(true)
    }
    setPickError('')
  }, [skill])

  const pickFile = async (): Promise<void> => {
    setPicking(true)
    setPickError('')
    try {
      const result = await window.api.file.select()
      if (result.canceled || result.files.length === 0) return
      const picked = result.files[0]
      setFilePath(picked.path)
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e))
    } finally {
      setPicking(false)
    }
  }

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const base = {
      name: name.trim(),
      description: description.trim(),
      filePath: filePath.trim(),
      enabled
    }
    if (skill) {
      onSave({ ...base, id: skill.id })
    } else {
      onSave(base)
    }
  }

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <label className="settings-form__label">
        Name
        <input
          className="settings-form__input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. flow-walkthrough"
          required
        />
      </label>

      <label className="settings-form__label">
        Description
        <input
          className="settings-form__input"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="One line: what this skill does (shown to the agent by list_skills)"
          required
        />
      </label>

      <div className="settings-form__label">
        Skill file (.md)
        <div className="settings-form__file-row">
          <input
            className="settings-form__input"
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            placeholder="Absolute path to the skill .md file"
            required
          />
          <button
            type="button"
            className="settings-form__btn settings-form__btn--cancel"
            onClick={() => void pickFile()}
            disabled={picking}
          >
            {picking ? '...' : 'Browse'}
          </button>
        </div>
        {pickError && <span className="settings-form__error">{pickError}</span>}
      </div>

      <label className="settings-form__checkbox">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span className="settings-form__tool-label">Enabled (agent can see and load it)</span>
      </label>

      <div className="settings-form__actions">
        <button
          type="button"
          className="settings-form__btn settings-form__btn--cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="settings-form__btn settings-form__btn--save">
          Save
        </button>
      </div>
    </form>
  )
}