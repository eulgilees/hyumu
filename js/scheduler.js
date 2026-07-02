window.Hyumu = window.Hyumu || {};

Hyumu.Scheduler = (function () {
  const Model = Hyumu.Model;

  function setCell(schedule, empId, date, status, source, shift) {
    schedule[empId][date] = { status, source, shift: shift || null };
  }

  function isLocked(schedule, empId, date) {
    const cell = schedule[empId][date];
    return !!cell && (cell.source === 'BASE' || cell.source === 'MANUAL');
  }

  // Personal annual leave (연차) and 인정 leave are separate from the fairness/rest-day
  // rotation: an employee who already used annual leave should still receive their full
  // share of auto-assigned rest on top of it, not have the annual leave count against it.
  const EXEMPT_LEAVE_TYPES = ['ANNUAL', 'RECOGNIZED'];
  function isExemptLockedOff(emp, date, schedule) {
    const cell = schedule[emp.id][date];
    if (!cell || cell.status !== 'OFF' || cell.source !== 'BASE') return false;
    if (!emp.specificOff.includes(date)) return false;
    return EXEMPT_LEAVE_TYPES.includes(Model.leaveTypeOf(emp, date));
  }

  function generateSchedule(doc) {
    const { employees, rules, month } = doc;
    const dates = Model.allDatesOfMonth(month.year, month.month);
    const n = employees.length;

    const schedule = {};
    employees.forEach((emp) => {
      schedule[emp.id] = {};
    });

    // BASE cells are always recomputed fresh from employee definitions
    for (const emp of employees) {
      for (const date of dates) {
        if (Model.isBaseOff(emp, date)) {
          setCell(schedule, emp.id, date, 'OFF', 'BASE');
        }
      }
    }

    // carry forward previously saved MANUAL locks
    if (doc.schedule) {
      for (const emp of employees) {
        const prevEmp = doc.schedule[emp.id];
        if (!prevEmp) continue;
        for (const date of dates) {
          const prevCell = prevEmp[date];
          if (prevCell && prevCell.source === 'MANUAL') {
            setCell(schedule, emp.id, date, prevCell.status, 'MANUAL', prevCell.shift);
          }
        }
      }
    }

    const conflicts = [];

    if (n === 0) {
      doc.schedule = schedule;
      doc.conflicts = conflicts;
      return doc;
    }

    const consecutiveWork = {};
    const totalOff = {};
    const weekendOff = {};
    const redDayOff = {};
    const fairnessOff = {};
    employees.forEach((emp) => {
      consecutiveWork[emp.id] = 0;
      totalOff[emp.id] = 0;
      weekendOff[emp.id] = 0;
      redDayOff[emp.id] = 0;
      fairnessOff[emp.id] = 0;
    });

    // lockedOffCount excludes exempt (연차/인정) leave so those days don't eat into the
    // guaranteed auto-rest target; fairnessOff (built up below in the Phase 1 loop) mirrors
    // this by excluding exempt days from the running deficit calculation too.
    const lockedOffCount = {};
    employees.forEach((emp) => {
      lockedOffCount[emp.id] = 0;
    });
    for (const emp of employees) {
      for (const date of dates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) lockedOffCount[emp.id]++;
      }
    }

    // 목표 휴무일수(rules.targetOffDays)가 있으면 그게 곧 목표다 — 최소 근무 인원에서
    // 역산한 값이 아니라, 사용자가 직접 정한 숫자. 최소 인원 요건은 이 목표를 채우는 데
    // 방해가 되면 안 되고(휴무가 최우선), 아래 Phase 1에서도 일일 남은 슬롯 계산을 이
    // 목표에 맞춰 페이싱하지 최소인원 여유분으로 캡을 걸지 않는다.
    const baseTarget = rules.targetOffDays != null && rules.targetOffDays !== ''
      ? Number(rules.targetOffDays)
      : (() => {
          let totalOffSlots = 0;
          for (const date of dates) {
            const req = Model.minStaffRequired(rules, date);
            totalOffSlots += Math.max(0, n - req);
          }
          return totalOffSlots / n;
        })();
    const target = {};
    employees.forEach((emp) => {
      target[emp.id] = Math.max(lockedOffCount[emp.id], baseTarget);
    });
    const totalTargetSum = employees.reduce((sum, emp) => sum + target[emp.id], 0);

    const cap = rules.maxConsecutiveWorkDays;
    const effectiveCap = rules.minRestPerWeekWindow ? Math.min(cap, 6) : cap;
    const shiftMinTotal = (rules.minMorningStaff || 0) + (rules.minAfternoonStaff || 0);

    const cornerShiftMin = rules.minStaffByCorner || {};
    const cornerMinStaff = {};
    Object.entries(cornerShiftMin).forEach(([corner, req]) => {
      cornerMinStaff[corner] = (req.morning || 0) + (req.afternoon || 0);
    });
    const cornerTotal = {};
    employees.forEach((emp) => {
      Model.employeeCorners(emp).forEach((c) => {
        cornerTotal[c] = (cornerTotal[c] || 0) + 1;
      });
    });

    // Fairness group headcount: small sub-corners (e.g. 기프트/학용/필기구/디자인문구)
    // are pooled together per Model.cornerFairnessGroup so red-day rest is shared
    // across the whole pool rather than computed per tiny individual corner.
    const fairnessGroupTotal = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      if (corners.length === 1) {
        const key = Model.cornerFairnessGroup(corners[0]);
        if (key) fairnessGroupTotal[key] = (fairnessGroupTotal[key] || 0) + 1;
      }
    });

    // Red-day (Sat/Sun/holiday) fairness: each employee should get an even share of
    // red-day OFF within their own corner, since red days are when the store needs
    // the most coverage and weekdays are when everyone rests anyway.
    const redDates = dates.filter((date) => Model.isWeekend(date) || Model.isRedDay(date));
    const lockedRedDayOffCount = {};
    employees.forEach((emp) => {
      lockedRedDayOffCount[emp.id] = 0;
    });
    for (const emp of employees) {
      for (const date of redDates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) lockedRedDayOffCount[emp.id]++;
      }
    }
    const fairnessRedDayOff = {};
    employees.forEach((emp) => { fairnessRedDayOff[emp.id] = 0; });
    const redDayTarget = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      let base;
      if (corners.length === 1) {
        const key = Model.cornerFairnessGroup(corners[0]);
        if (key && fairnessGroupTotal[key]) {
          base = redDates.length / fairnessGroupTotal[key];
        } else {
          base = redDates.length / n;
        }
      } else {
        base = redDates.length / n;
      }
      redDayTarget[emp.id] = Math.max(lockedRedDayOffCount[emp.id], base);
    });

    // Phase 1: chronological greedy fill
    // totalOffSoFar tracks the running sum of fairnessOff across all employees, used below to
    // pace daily rest slots against the target instead of against staffing headroom.
    let totalOffSoFar = 0;
    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      const date = dates[dayIndex];
      const weekend = Model.isWeekend(date);
      const redDay = weekend || Model.isRedDay(date);
      const req = Math.max(Model.minStaffRequired(rules, date), shiftMinTotal);

      const lockedEmployees = [];
      const freeEmployees = [];
      for (const emp of employees) {
        if (isLocked(schedule, emp.id, date)) lockedEmployees.push(emp);
        else freeEmployees.push(emp);
      }
      const fixedOffCount = lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').length;

      if (n - fixedOffCount < req) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 고정/수동 휴무만으로 최소 근무 인원(${req}명)을 채울 수 없습니다.`,
          employeeIds: lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').map((e) => e.id)
        });
      }

      // Kept for conflict messaging only — no longer used to cap how many people can rest
      // today, since the target off-days count outranks minimum staffing (사장님 지시).
      const allowedAdditionalOff = Math.max(0, n - req - fixedOffCount);

      const forcedOff = freeEmployees.filter((emp) => consecutiveWork[emp.id] >= effectiveCap);
      const forcedIds = new Set(forcedOff.map((e) => e.id));

      if (forcedOff.length > allowedAdditionalOff) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 연속 근무 제한(${effectiveCap}일)으로 쉬어야 하는 인원이 많아 최소 근무 인원(${req}명)을 유지할 수 없습니다.`,
          employeeIds: forcedOff.map((e) => e.id)
        });
      }

      forcedOff.forEach((emp) => setCell(schedule, emp.id, date, 'OFF', 'AUTO_FORCED'));

      // Pace today's rest slots against the target trajectory (how much of totalTargetSum
      // "should" be used up by this point in the month), not against staffing headroom.
      const desiredCumulative = Math.round((totalTargetSum * (dayIndex + 1)) / dates.length);
      const remainingSlots = Math.max(0, desiredCumulative - totalOffSoFar - forcedOff.length);
      const candidates = freeEmployees.filter((emp) => !forcedIds.has(emp.id));

      // Per-corner OFF budget is informational only from here on — corner staffing must not
      // block someone from reaching their target off-days count.
      const cornerOffUsed = {};
      [...lockedEmployees.filter((e) => schedule[e.id][date].status === 'OFF'), ...forcedOff].forEach((emp) => {
        Model.employeeCorners(emp).forEach((c) => {
          cornerOffUsed[c] = (cornerOffUsed[c] || 0) + 1;
        });
      });
      const cornerAllowedOff = {};
      Object.keys(cornerTotal).forEach((corner) => {
        cornerAllowedOff[corner] = Math.max(0, cornerTotal[corner] - (cornerMinStaff[corner] || 0));
      });
      Object.entries(cornerOffUsed).forEach(([corner, used]) => {
        if (cornerAllowedOff[corner] != null && used > cornerAllowedOff[corner]) {
          conflicts.push({
            date,
            type: 'CORNER_MIN_STAFF_VIOLATION',
            message: `${date}: 고정/수동/강제 휴무만으로 '${corner}' 코너 최소 인원(${cornerMinStaff[corner] || 0}명)을 채울 수 없습니다.`,
            employeeIds: []
          });
        }
      });

      candidates.sort((a, b) => {
        if (redDay) {
          const redDeficitA = redDayTarget[a.id] - fairnessRedDayOff[a.id];
          const redDeficitB = redDayTarget[b.id] - fairnessRedDayOff[b.id];
          if (redDeficitB !== redDeficitA) return redDeficitB - redDeficitA;
        }
        const deficitA = target[a.id] - fairnessOff[a.id];
        const deficitB = target[b.id] - fairnessOff[b.id];
        if (deficitB !== deficitA) return deficitB - deficitA;
        if (weekend) {
          const wDiff = weekendOff[a.id] - weekendOff[b.id];
          if (wDiff !== 0) return wDiff;
        }
        const streakDiff = consecutiveWork[b.id] - consecutiveWork[a.id];
        if (streakDiff !== 0) return streakDiff;
        return employees.indexOf(a) - employees.indexOf(b);
      });

      // Corner caps are informational (see above) — a corner going over its cap because
      // people needed rest to hit their target is flagged below, not blocked here.
      const cornersOverCap = new Set();
      const chosenOff = [];
      for (const emp of candidates) {
        if (chosenOff.length >= remainingSlots) break;
        // On red days, once someone has already taken their fair share of red-day rest,
        // leave them working rather than filling every allowed slot with rest -- red days
        // are meant to be mostly worked, only rotated rest per corner.
        if (redDay && fairnessRedDayOff[emp.id] >= Math.ceil(redDayTarget[emp.id])) continue;
        const empCorners = Model.employeeCorners(emp);
        chosenOff.push(emp);
        empCorners.forEach((c) => {
          cornerOffUsed[c] = (cornerOffUsed[c] || 0) + 1;
          if (cornerAllowedOff[c] != null && cornerOffUsed[c] > cornerAllowedOff[c]) cornersOverCap.add(c);
        });
      }
      const chosenOffIds = new Set(chosenOff.map((e) => e.id));

      cornersOverCap.forEach((corner) => {
        conflicts.push({
          date,
          type: 'CORNER_MIN_STAFF_VIOLATION',
          message: `${date}: 목표 휴무일수를 맞추기 위해 '${corner}' 코너 최소 인원(${cornerMinStaff[corner] || 0}명) 미만으로 근무합니다.`,
          employeeIds: []
        });
      });

      candidates.filter((emp) => chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'OFF', 'AUTO_FAIRNESS'));
      candidates.filter((emp) => !chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'WORK', 'AUTO'));

      for (const emp of employees) {
        const cell = schedule[emp.id][date];
        if (cell.status === 'OFF') {
          consecutiveWork[emp.id] = 0;
          totalOff[emp.id]++;
          if (weekend) weekendOff[emp.id]++;
          if (redDay) redDayOff[emp.id]++;
          if (!isExemptLockedOff(emp, date, schedule)) {
            fairnessOff[emp.id]++;
            totalOffSoFar++;
            if (redDay) fairnessRedDayOff[emp.id]++;
          }
        } else {
          consecutiveWork[emp.id]++;
        }
      }
    }

    rebalanceRedDays(schedule, employees, redDates, dates, effectiveCap, fairnessRedDayOff, conflicts);
    // Recompute weekdayOff straight from the schedule (not by subtracting fairnessRedDayOff
    // from the pre-rebalance fairnessOff) — rebalanceRedDays just swapped OFF/WORK cells on
    // red days, so that subtraction would use a stale fairnessOff and desync from reality.
    const weekdayDates = dates.filter((date) => !(Model.isWeekend(date) || Model.isRedDay(date)));
    const weekdayOff = {};
    employees.forEach((emp) => {
      let count = 0;
      for (const date of weekdayDates) {
        const cell = schedule[emp.id][date];
        if (cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) count++;
      }
      weekdayOff[emp.id] = count;
    });
    rebalance(schedule, employees, weekdayDates, dates, effectiveCap, weekdayOff, conflicts);
    assignShifts(schedule, employees, dates, rules, conflicts);

    // Weekday and red-day rest are each balanced to within 1 day *within their own dimension*,
    // but that doesn't guarantee the combined monthly total is close for everyone (e.g. the
    // consecutive-work cap can block a weekday swap that would've closed the gap). Surface it
    // explicitly so an unresolved overall imbalance isn't silently invisible to the user.
    let maxTotalOff = -Infinity;
    let minTotalOff = Infinity;
    employees.forEach((emp) => {
      let count = 0;
      for (const date of dates) {
        if (schedule[emp.id][date].status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) count++;
      }
      maxTotalOff = Math.max(maxTotalOff, count);
      minTotalOff = Math.min(minTotalOff, count);
    });
    if (maxTotalOff - minTotalOff > 1) {
      conflicts.push({
        date: null,
        type: 'IMBALANCE_NOTICE',
        message: `전체 휴무일수를 완전한 균형으로 맞추지 못했습니다 (최대 ${maxTotalOff}일, 최소 ${minTotalOff}일). 연속 근무 제한 등으로 더 이상 스왑할 수 없는 경우입니다.`,
        employeeIds: []
      });
    }

    doc.schedule = schedule;
    doc.conflicts = conflicts;
    return doc;
  }

  function assignShifts(schedule, employees, dates, rules, conflicts) {
    const minMorning = rules.minMorningStaff || 0;
    const minAfternoon = rules.minAfternoonStaff || 0;
    const cornerShiftMin = rules.minStaffByCorner || {};
    const hasCornerShiftReq = Object.values(cornerShiftMin).some((req) => (req.morning || 0) > 0 || (req.afternoon || 0) > 0);
    if (minMorning === 0 && minAfternoon === 0 && !hasCornerShiftReq && !employees.some((e) => e.shiftPreference !== 'ANY')) {
      return;
    }

    const morningCount = {};
    const afternoonCount = {};
    employees.forEach((e) => {
      morningCount[e.id] = 0;
      afternoonCount[e.id] = 0;
    });

    for (const date of dates) {
      const workingToday = employees.filter((e) => schedule[e.id][date] && schedule[e.id][date].status === 'WORK');

      const lockedMorning = [];
      const lockedAfternoon = [];
      let flexible = [];

      for (const e of workingToday) {
        const cell = schedule[e.id][date];
        if (cell.source === 'MANUAL' && cell.shift) {
          if (cell.shift === 'MORNING') lockedMorning.push(e);
          else lockedAfternoon.push(e);
        } else if (e.shiftPreference === 'MORNING') {
          lockedMorning.push(e);
        } else if (e.shiftPreference === 'AFTERNOON') {
          lockedAfternoon.push(e);
        } else {
          flexible.push(e);
        }
      }

      const byMorningNeedAsc = (a, b) =>
        (morningCount[a.id] - afternoonCount[a.id]) - (morningCount[b.id] - afternoonCount[b.id]);

      // Corner-level minimums are satisfied first, pulling from that corner's flexible pool only
      Object.entries(cornerShiftMin).forEach(([corner, req]) => {
        const needM = req.morning || 0;
        const needA = req.afternoon || 0;
        if (needM === 0 && needA === 0) return;
        const cornerWorking = workingToday.filter((e) => Model.employeeCorners(e).includes(corner));
        const cornerLockedM = lockedMorning.filter((e) => Model.employeeCorners(e).includes(corner)).length;
        const cornerLockedA = lockedAfternoon.filter((e) => Model.employeeCorners(e).includes(corner)).length;
        const cornerFlexible = flexible.filter((e) => Model.employeeCorners(e).includes(corner));
        const remainM = Math.max(0, needM - cornerLockedM);
        const remainA = Math.max(0, needA - cornerLockedA);

        if (remainM + remainA > cornerFlexible.length) {
          conflicts.push({
            date,
            type: 'CORNER_SHIFT_MIN_VIOLATION',
            message: `${date}: '${corner}' 코너 오전/오후 최소 인원(오전 ${needM}명, 오후 ${needA}명)을 채울 인원이 부족합니다.`,
            employeeIds: cornerWorking.map((e) => e.id)
          });
        }

        cornerFlexible.sort(byMorningNeedAsc);
        const pickM = cornerFlexible.slice(0, remainM);
        const pickMIds = new Set(pickM.map((e) => e.id));
        const remainingCornerFlex = cornerFlexible.filter((e) => !pickMIds.has(e.id));
        remainingCornerFlex.sort((a, b) => byMorningNeedAsc(b, a));
        const pickA = remainingCornerFlex.slice(0, remainA);
        const pickAIds = new Set(pickA.map((e) => e.id));

        flexible = flexible.filter((e) => !pickMIds.has(e.id) && !pickAIds.has(e.id));
        lockedMorning.push(...pickM);
        lockedAfternoon.push(...pickA);
      });

      const needMorning = Math.max(0, minMorning - lockedMorning.length);
      const needAfternoon = Math.max(0, minAfternoon - lockedAfternoon.length);

      if (needMorning + needAfternoon > flexible.length) {
        conflicts.push({
          date,
          type: 'SHIFT_MIN_VIOLATION',
          message: `${date}: 오전/오후 최소 인원(오전 ${minMorning}명, 오후 ${minAfternoon}명)을 모두 채울 인원이 부족합니다.`,
          employeeIds: workingToday.map((e) => e.id)
        });
      }

      flexible.sort(byMorningNeedAsc);
      const chosenMorning = flexible.slice(0, needMorning);
      const chosenMorningIds = new Set(chosenMorning.map((e) => e.id));
      const afterMorningPick = flexible.filter((e) => !chosenMorningIds.has(e.id));

      afterMorningPick.sort((a, b) => byMorningNeedAsc(b, a));
      const chosenAfternoon = afterMorningPick.slice(0, needAfternoon);
      const chosenAfternoonIds = new Set(chosenAfternoon.map((e) => e.id));
      const leftover = afterMorningPick.filter((e) => !chosenAfternoonIds.has(e.id));

      let dayMorningCount = lockedMorning.length + chosenMorning.length;
      let dayAfternoonCount = lockedAfternoon.length + chosenAfternoon.length;

      leftover.sort(byMorningNeedAsc);
      for (const e of leftover) {
        const diff = morningCount[e.id] - afternoonCount[e.id];
        const assignMorning = diff < 0 || (diff === 0 && dayMorningCount <= dayAfternoonCount);
        if (assignMorning) {
          chosenMorning.push(e);
          dayMorningCount++;
        } else {
          chosenAfternoon.push(e);
          dayAfternoonCount++;
        }
      }

      [...lockedMorning, ...chosenMorning].forEach((e) => {
        schedule[e.id][date].shift = 'MORNING';
      });
      [...lockedAfternoon, ...chosenAfternoon].forEach((e) => {
        schedule[e.id][date].shift = 'AFTERNOON';
      });

      for (const e of workingToday) {
        if (schedule[e.id][date].shift === 'MORNING') morningCount[e.id]++;
        else afternoonCount[e.id]++;
      }
    }
  }

  // swapDates: which dates are eligible to swap on. allDates: the full month, used to
  // correctly measure consecutive-workday streaks across day boundaries not in swapDates.
  function rebalance(schedule, employees, swapDates, allDates, effectiveCap, offCount, conflicts) {
    if (employees.length < 2) return;
    const maxIterations = employees.length * swapDates.length * 4;
    let iterations = 0;

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCap(empId, date) {
      const idx = allDates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, allDates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < allDates.length && statusOn(empId, allDates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > effectiveCap;
    }

    while (iterations < maxIterations) {
      iterations++;
      const sortedDesc = [...employees].sort((a, b) => offCount[b.id] - offCount[a.id]);
      const sortedAsc = [...employees].sort((a, b) => offCount[a.id] - offCount[b.id]);

      let swapped = false;
      outer: for (const eMax of sortedDesc) {
        for (const eMin of sortedAsc) {
          if (eMax.id === eMin.id) continue;
          if (offCount[eMax.id] - offCount[eMin.id] <= 1) break outer;

          let chosenDate = null;
          for (const date of swapDates) {
            if (
              sourceOn(eMax.id, date) === 'AUTO_FAIRNESS' &&
              statusOn(eMax.id, date) === 'OFF' &&
              sourceOn(eMin.id, date) === 'AUTO' &&
              statusOn(eMin.id, date) === 'WORK' &&
              !wouldExceedCap(eMax.id, date)
            ) {
              chosenDate = date;
              break;
            }
          }

          if (chosenDate) {
            schedule[eMax.id][chosenDate] = { status: 'WORK', source: 'AUTO' };
            schedule[eMin.id][chosenDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
            offCount[eMax.id]--;
            offCount[eMin.id]++;
            swapped = true;
            break outer;
          }
        }
      }
      if (!swapped) break;
    }

    let maxOff = -Infinity;
    let minOff = Infinity;
    for (const emp of employees) {
      maxOff = Math.max(maxOff, offCount[emp.id]);
      minOff = Math.min(minOff, offCount[emp.id]);
    }
    if (maxOff - minOff > 1) {
      conflicts.push({
        date: null,
        type: 'IMBALANCE_NOTICE',
        message: `평일 휴무를 완전한 균형으로 맞추지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
        employeeIds: []
      });
    }
  }

  // Balances red-day (weekend/holiday) OFF within each single-corner group so members
  // take turns resting on red days roughly evenly; multi-corner/no-corner employees
  // fall back to a store-wide group.
  function rebalanceRedDays(schedule, employees, redDates, allDates, effectiveCap, redDayOff, conflicts) {
    if (employees.length < 2 || redDates.length === 0) return;

    const groups = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      const key = corners.length === 1 ? Model.cornerFairnessGroup(corners[0]) || '__store__' : '__store__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(emp);
    });

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCap(empId, date) {
      const idx = allDates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, allDates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < allDates.length && statusOn(empId, allDates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > effectiveCap;
    }

    Object.entries(groups).forEach(([groupKey, groupEmployees]) => {
      if (groupEmployees.length < 2) return;
      const maxIterations = groupEmployees.length * redDates.length * 4;
      let iterations = 0;

      while (iterations < maxIterations) {
        iterations++;
        const sortedDesc = [...groupEmployees].sort((a, b) => redDayOff[b.id] - redDayOff[a.id]);
        const sortedAsc = [...groupEmployees].sort((a, b) => redDayOff[a.id] - redDayOff[b.id]);

        let swapped = false;
        outer: for (const eMax of sortedDesc) {
          for (const eMin of sortedAsc) {
            if (eMax.id === eMin.id) continue;
            if (redDayOff[eMax.id] - redDayOff[eMin.id] <= 1) break outer;

            let chosenDate = null;
            for (const date of redDates) {
              if (
                sourceOn(eMax.id, date) === 'AUTO_FAIRNESS' &&
                statusOn(eMax.id, date) === 'OFF' &&
                sourceOn(eMin.id, date) === 'AUTO' &&
                statusOn(eMin.id, date) === 'WORK' &&
                !wouldExceedCap(eMax.id, date)
              ) {
                chosenDate = date;
                break;
              }
            }

            if (chosenDate) {
              schedule[eMax.id][chosenDate] = { status: 'WORK', source: 'AUTO' };
              schedule[eMin.id][chosenDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
              redDayOff[eMax.id]--;
              redDayOff[eMin.id]++;
              swapped = true;
              break outer;
            }
          }
        }
        if (!swapped) break;
      }

      let maxOff = -Infinity;
      let minOff = Infinity;
      for (const emp of groupEmployees) {
        maxOff = Math.max(maxOff, redDayOff[emp.id]);
        minOff = Math.min(minOff, redDayOff[emp.id]);
      }
      if (maxOff - minOff > 1 && groupKey !== '__store__') {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `'${groupKey}' 코너는 빨간날(주말/공휴일) 휴무를 완전히 고르게 나누지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
          employeeIds: []
        });
      }
    });
  }

  return { generateSchedule };
})();
