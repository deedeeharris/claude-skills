# Notification Delivery PRD

## 1. Purpose

The system notifies account holders about changes to their account so they are not
surprised by activity they did not expect.

## 2. Requirements

### R1

The system shall notify the user when an important account event occurs.

### R2

Notifications shall be delivered fast and reliable.

### R3

The user shall be able to view their last 50 notifications in the account activity
screen, sorted newest first. A notification not acknowledged within 30 days is removed
from this list.

### R4

The system shall record, for every notification sent, the timestamp, the channel used,
and the delivery outcome, retained for 90 days.

## 3. Out of Scope

Push notifications to native mobile apps are out of scope for this release; only email
and in-app notifications are covered.
