# Remote CCP

Remote CCP is a CP/M application which runs on the traget CP/M device and provides a set of services over the serial line.

On start up it executes:

- BDOS 13 DRV_ALLRESET
- BDOS 12 S_BDOSVER

Return version byte and waits for commands which are sent as short strings:

Command | Description | Action
-|-|- 
Q | Quit to CCP | Return ACK and then quit to CCP
DC | Current Drive | Return current drive letter as a single char then EOT e.g. A\<EOT\>
DL | Drive List | Calls the BIOS SELDSK entry directly for each drive A-P (HL=0000H means the drive doesn't exist) rather than going through BDOS 14, since some BDOS builds print "BDOS ERR ON x: SELECT" and wait for a keypress on a bad drive instead of just returning. Return all valid drives as a string of letters e.g. ABEF\<EOT\>
DS\<letter\> | Set Drive | Set to letter using BDOS 14 DRV_SET. Since this can involve real disk I/O (mounting/seeking) that takes a while, an ACK is sent once the select is done - the sender must wait for this before its next command
DG | Disk get | Return current selected disk letter using BDOS 25 DRV_GET
FL | List Files | List file on current drive - Use BDOS 17 F_SFIRST and BDOS 18 F_SNEXT streaming the results as filename\|record count\|filename\|record count\|etc. Record count is 2 hex chars
FG\<filename\> | Get file | Use BDOS 17 F_SFIRST then return file as blocks - each block is encoded as a hex string with a one byte check sum which is sent and a ACK, NAK or ETX is sent back by reciever - NACK means resend, ACK means next block, ETX means abandon transfer. Count errors and send EOT when comoplete or ETX to abandon after too mnay erors
FP\<filename\> | Put file | If file exists it is deleted first using BDOS 19 F_DELETE, then created using BDOS 22 F_MAKE. Since this is real disk I/O and can take a while, an ACK is sent once the file is ready (or ETX if creation failed) - the sender must wait for this before streaming the first block. After that, same block protocol as FG but roles swapped and file is written to disk
