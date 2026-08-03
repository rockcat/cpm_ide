;==============================================================
;  DRVTEST - drive detection via BIOS SELDSK
;==============================================================
;Standalone CP/M 2.2 diagnostic .COM - no host/serial link
;involved, just run it directly at the console. For each of A:
;through P:, calls the BIOS's SELDSK entry directly (bypassing
;BDOS entirely): HL=0000H on return means the drive doesn't
;exist. Prints a letter for every drive it considers present, or
;a dot if not. Mirrors remotccp.asm's DO_DL command exactly.
;
;Restores whatever drive was current before returning to the CCP.
;==============================================================

	org	100h

;----------------------
;BDOS entry point & functions
;----------------------
BDOS		equ	0005h

C_WRITE		equ	2	;E=char to send
DRV_SET		equ	14	;E=drive 0-15
DRV_GET		equ	25	;returns drive 0-15 in A

CR	equ	0Dh
LF	equ	0Ah

;Offset of the SELDSK entry within the 17-entry BIOS jump table
;(BOOT, WBOOT, CONST, CONIN, CONOUT, LIST, PUNCH, READER, HOME,
;SELDSK, ...) - fixed by the standard CP/M 2.2 BIOS layout.
SELDSK_OFS	equ	27

;==============================================================
;Startup: remember the current drive, locate the BIOS jump
;table, run the scan, then restore the original drive.
;==============================================================
START:	ld	c,DRV_GET
	call	BDOS
	ld	(ORIGDRV),a

	;The warm-boot vector at 0001H points at the BIOS jump
	;table's second entry (BOOT is the first, at BIOSBASE+0) -
	;subtracting 3 gives the table's start.
	ld	hl,(1)
	ld	de,3
	or	a
	sbc	hl,de
	ld	(BIOSBASE),hl

	ld	de,MSGHDR
	call	PRNSTR
	call	TEST_SELDSK
	call	PRNCRLF

	ld	a,(ORIGDRV)
	ld	e,a
	ld	c,DRV_SET
	call	BDOS
	jp	0		;back to CCP (warm boot) - not a bare RET: that
				;relies on the CCP having pre-loaded the stack
				;with the warm-boot address before jumping into
				;this program, which isn't true on every BIOS
				;(observed rebooting in a loop on a Z80-MBC2
				;board otherwise) - JP 0 doesn't depend on that.

;--------------------------------------------------------------
;BIOS SELDSK, called directly. For each drive 0-15, calls the
;BIOS's SELDSK entry with C=drive; HL=0000H on return means the
;drive doesn't exist. Mirrors remotccp.asm's DO_DL.
;--------------------------------------------------------------
TEST_SELDSK:	xor	a
	ld	(DRVIDX),a
TSD_LP:	ld	a,(DRVIDX)
	ld	c,a		;C = drive number for SELDSK
	ld	hl,(BIOSBASE)
	ld	de,SELDSK_OFS
	add	hl,de		;HL -> SELDSK's jump-table entry
	ld	de,0		;E=0: tell the BIOS to re-verify the media
	call	CALLHL		;-> HL = DPH address, or 0000H if no such drive
	ld	a,h
	or	l
	jp	z,TSD_SKIP
	ld	a,(DRVIDX)
	add	a,'A'
	call	PRNCHR
	jp	TSD_NEXT
TSD_SKIP:	ld	a,'.'
	call	PRNCHR
TSD_NEXT:	ld	a,(DRVIDX)
	inc	a
	ld	(DRVIDX),a
	cp	16
	jp	c,TSD_LP
	ret

;Z80 has no "CALL (HL)" opcode - CALL here pushes the return
;address, then JP (HL) transfers control to HL without touching
;the stack, so the callee's own RET lands back right after the
;"call CALLHL".
CALLHL:	jp	(hl)

;==============================================================
;Console output helpers
;==============================================================

;DE -> '$'-terminated string. Prints one character at a time via
;PRNCHR/BDOS 2, rather than handing the whole string to BDOS 9
;(C_WRITESTR) in one call - on at least one piece of real
;hardware, a burst of characters with no pacing between them
;(which is exactly what BDOS 9's own internal loop does) has come
;back garbled/interleaved with stale output, while individually
;paced PRNCHR calls elsewhere in this program (drive letters,
;each with real BIOS disk I/O in between) have come through
;clean every time - this gives the header string that same
;natural per-character pacing instead of one fast burst.
PRNSTR:	push	af
	push	de
PS_LP:	ld	a,(de)
	cp	'$'
	jp	z,PS_DONE
	call	PRNCHR
	inc	de
	jp	PS_LP
PS_DONE:	pop	de
	pop	af
	ret

;A = char to send
PRNCHR:	push	bc
	push	de
	push	hl
	ld	e,a
	ld	c,C_WRITE
	call	BDOS
	pop	hl
	pop	de
	pop	bc
	ret

PRNCRLF:	ld	a,CR
	call	PRNCHR
	ld	a,LF
	call	PRNCHR
	ret

;==============================================================
;Data
;==============================================================
MSGHDR:	db	'BIOS SELDSK drive scan (missing drives shown as a dot): $'

ORIGDRV:	ds	1
DRVIDX:	ds	1
BIOSBASE:	ds	2

	end
