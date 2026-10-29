package store

import (
	"encoding/json"

	"github.com/stream-kit/orchestrator/internal/model"
)

func (s *Store) UpsertStreamSession(record *model.StreamSession) error {
	return s.DB.Save(record).Error
}

func (s *Store) GetStreamSession(id string) (*model.StreamSession, error) {
	var record model.StreamSession
	if err := s.DB.First(&record, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *Store) ListStreamSessions() ([]model.StreamSession, error) {
	var records []model.StreamSession
	if err := s.DB.Order("created_at ASC").Find(&records).Error; err != nil {
		return nil, err
	}
	return records, nil
}

func (s *Store) DeleteStreamSession(id string) error {
	return s.DB.Delete(&model.StreamSession{}, "id = ?", id).Error
}

func EncodeStreamSessionSnapshot(audio, policy, connections interface{}) (string, string, string, error) {
	a, err := json.Marshal(audio)
	if err != nil { return "", "", "", err }
	p, err := json.Marshal(policy)
	if err != nil { return "", "", "", err }
	c, err := json.Marshal(connections)
	if err != nil { return "", "", "", err }
	return string(a), string(p), string(c), nil
}

func DecodeStreamSessionSnapshot(record *model.StreamSession, audio, policy, connections interface{}) error {
	if err := json.Unmarshal([]byte(record.AudioJSON), audio); err != nil { return err }
	if err := json.Unmarshal([]byte(record.PolicyJSON), policy); err != nil { return err }
	return json.Unmarshal([]byte(record.ConnectionsJSON), connections)
}
