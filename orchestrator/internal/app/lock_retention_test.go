package app

import (
	"fmt"
	"sync"
	"testing"
)

func TestApplicationOperationLocksDoNotRetainCompletedIDs(t *testing.T) {
	m := &Manager{}
	for i := 0; i < 20000; i++ {
		unlock, err := m.TryLock(fmt.Sprint(i))
		if err != nil {
			t.Fatal(err)
		}
		unlock()
	}
	count := 0
	m.locks.Range(func(_, _ any) bool { count++; return true })
	if count != 0 {
		t.Fatalf("completed operation IDs retained: %d", count)
	}
}

func TestApplicationOperationLockRejectsContendersAndStaleRelease(t *testing.T) {
	m := &Manager{}
	unlock, err := m.TryLock("same-app")
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for i := 0; i < 100; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if release, e := m.TryLock("same-app"); e == nil {
				release()
				t.Error("concurrent operation admitted")
			}
		}()
	}
	wait.Wait()
	unlock()
	newOwner, err := m.TryLock("same-app")
	if err != nil {
		t.Fatal(err)
	}
	unlock() // An old completion must never release a replacement owner.
	if release, e := m.TryLock("same-app"); e == nil {
		release()
		t.Fatal("stale release removed new owner")
	}
	newOwner()
}
